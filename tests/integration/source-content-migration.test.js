import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {migrateSourceContent} from '../../scripts/migrate-source-content.js';
import {LYRIC_SELECTION_REVISION,validLyricStructure} from '../../api/utils/lyric-annotations.js';

test('legacy credits are moved out of stored source arrays and history is retired idempotently',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const old=structuredClone(source);
  old.structure={version:'lyric-annotations-2',speakers:[],annotations:[{sourceIndex:0,kind:'production_credit'}],
    sourceRows:[{text:'键盘：测试乐手',timestamp:1},{text:'把今天唱成一首歌',timestamp:10}],
    occurrences:[{sourceID:'L0001',sourceIndex:1,sourceText:'把今天唱成一首歌',lyricText:'把今天唱成一首歌',sourcePrefix:'',speakerID:null,startsTurn:false}]};
  old.response.lines[0].timestamp=10;old.response.metadata.lyric_structure=old.structure;
  await store.saveDocument(old);
  assert.deepEqual(await migrateSourceContent(db),{migrated:1});
  const next=await store.documentForRequest(old.requestKey,LYRIC_SELECTION_REVISION);
  assert.notEqual(next.id,old.id);assert.equal(next.response.lines[0].timestamp,10);
  assert.equal(next.response.song_details.credits[0].original,'键盘：测试乐手');
  assert.ok(validLyricStructure(next.structure,next.response.lines));
  const persisted=(await db.query('SELECT response,structure FROM lyric_documents WHERE id=$1',[next.id])).rows[0];
  assert.ok(!JSON.stringify(persisted).includes('测试乐手'));
  const retired=(await db.query('SELECT response,structure FROM lyric_documents WHERE id=$1',[old.id])).rows[0];
  assert.deepEqual(retired.response,{retired:true,replacement_id:next.id});
  const archive=(await db.query('SELECT response,structure FROM lyric_source_archives WHERE document_id=$1',[old.id])).rows[0];
  assert.deepEqual(archive.structure,old.structure);assert.deepEqual(archive.response.lines,old.response.lines);
  await assert.rejects(db.query('DELETE FROM lyric_source_archives WHERE document_id=$1',[old.id]),/translation_revision_immutable/);
  assert.ok(!JSON.stringify(retired).includes('测试乐手'));assert.equal(await store.document(old.id),null);
  assert.deepEqual(await migrateSourceContent(db),{migrated:0});
});

test('legacy repeated provider translation is split and creates a new source identity',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const old=structuredClone(source);
  old.response.lines=['一起唱^Sing together.','今天唱^Sing today.','明天唱^Sing tomorrow.'].map((original,i)=>({original,romanized:original,timestamp:i*10}));
  old.structure={version:'source-speakers-1',speakers:[],occurrences:[]};await store.saveDocument(old);
  await migrateSourceContent(db);const next=await store.documentForRequest(old.requestKey,LYRIC_SELECTION_REVISION);
  assert.deepEqual(next.response.lines.map(l=>l.original),['一起唱','今天唱','明天唱']);
  assert.equal(next.response.provider_translation.lines.length,3);
  assert.ok(!next.response.lines.some(l=>l.romanized.includes('Sing')));
  assert.notEqual(next.sourceHash,old.sourceHash);assert.ok(validLyricStructure(next.structure,next.response.lines));
});

test('active generation prevents retirement and rolls back the entire migration',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());await store.saveDocument(source);
  await store.reserve({userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:1});
  await assert.rejects(migrateSourceContent(db),/source_migration_active_generation/);
  assert.equal((await store.document(source.id)).response.lines.length,1);
  assert.equal((await db.query('SELECT count(*) AS n FROM lyric_documents')).rows[0].n,1);
});

test('refresh moves equivalent heads together and expired lookup leases cannot replace them',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());await store.saveDocument(source);
  await store.saveDocument({...source,requestKey:'alias'});
  const lease=await store.claimLookup(source.requestKey,source.selectionRevision);
  const next={...source,id:'next-source',sourceHash:'next-hash'};
  await store.saveDocument(next,{replaceID:source.id,lookupOwner:lease});
  assert.equal((await store.documentForRequest('alias',source.selectionRevision)).id,next.id);
  assert.equal(await store.isCurrentDocument(source.id,source.selectionRevision),false);
  await db.query("UPDATE lyric_lookups SET expires_at=now()-interval '1 second'");
  await assert.rejects(store.saveDocument({...next,id:'late-source'},{replaceID:next.id,lookupOwner:lease}),{code:'lookup_superseded'});
  assert.equal((await store.documentForRequest(source.requestKey,source.selectionRevision)).id,next.id);
  assert.equal(await store.document('late-source'),null);
});
