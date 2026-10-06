import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';

export async function libraryDB(path) {
  const db=new PGlite(path);
  await db.exec(await readFile(new URL('../../db/001-song-library.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('translation_reviews') AS table_name")).rows[0].table_name)
    await db.exec(await readFile(new URL('../../db/003-correction-foundation.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('correction_review_queue') AS table_name")).rows[0].table_name)
    await db.exec(await readFile(new URL('../../db/005-correction-batches.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('correction_review_outcomes') AS table_name")).rows[0].table_name)
    await db.exec(await readFile(new URL('../../db/007-correction-publication.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('study_explanations') AS table_name")).rows[0].table_name)
    await db.exec(await readFile(new URL('../../db/009-study-explanations.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='translation_jobs' AND column_name='generation_request'")).rows.length)
    await db.exec(await readFile(new URL('../../db/012-multilingual-content.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('pronunciation_aids') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/013-pronunciation-aids.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='lyric_requests' AND column_name='checked_at'")).rows.length)
    await db.exec(await readFile(new URL('../../db/014-lyric-source-refresh.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../db/015-gpt6-luna.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='library_users' AND column_name='unlimited_generation'")).rows.length)
    await db.exec(await readFile(new URL('../../db/016-personal-unlimited-access.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('translation_document_bindings') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/017-translation-reuse.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='translation_jobs' AND column_name='attempt'")).rows.length)
    await db.exec(await readFile(new URL('../../db/018-translation-attempts.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('catalog_recording_bindings') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/020-catalog-recording-bindings.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('app_attest_keys') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/021-app-auth.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('live_lyrics_push_receipts') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/022-live-lyrics-push.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../db/023-live-lyrics-runtime.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('live_lyrics_push_rate_windows_expiry') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/024-live-lyrics-cleanup.sql',import.meta.url),'utf8'));
  const store=new SongLibraryStore({query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn)});
  if(!(await db.query("SELECT to_regclass('membership_settings') AS name")).rows[0].name)
    await db.exec(await readFile(new URL('../../db/025-memberships.sql',import.meta.url),'utf8'));
  await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000});
  await store.createUser('reader-a','token-a');
  await store.createUser('reader-b','token-b');
  return {db,store};
}
export const source={id:'doc-one',recordingKey:'recording-one',requestKey:'request-one',sourceHash:'source-one',
  selectionRevision:'test-selection',response:{song:{title:{original:'Original test song'},artist:{original:'Test artist'},language:'zh'},
    quality:{synced:true,partial:false,instrumental:false},metadata:{source:'test'},
    lines:[{original:'把今天唱成一首歌',romanized:'bǎ jīn tiān chàng chéng yī shǒu gē',timestamp:0}]},
  structure:{speakers:[],occurrences:[{sourceID:'L0001',sourceText:'把今天唱成一首歌',lyricText:'把今天唱成一首歌',speakerID:null,startsTurn:false,sourcePrefix:''}]}};
