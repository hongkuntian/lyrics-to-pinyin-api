import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub,privacyScrubMarker,
  PRIVACY_CODEC_FIELDS} from '../../api/utils/listening-v2/privacy-codec.js';

// SQL is the independent byte-count oracle. These tests do not authenticate a
// profile, execute lifecycle writers, qualify real PG or establish a scan SLA.
const fields=['environment','persona_id','original_principal_id','original_key_id','controller_kind',
  'controller_principal_id','controller_key_id','privacy_generation','status','guest_credential_digest',
  'guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','scrub_cursor','created_at_ms',
  'updated_at_ms','controller_privacy_epoch','private_transfer_from_generation'];
const max=Number.MAX_SAFE_INTEGER,day=86400000;
const id='00000000-0000-0000-0000-000000000001',key=Buffer.alloc(32,1).toString('base64');
const hash='a'.repeat(64),env='test';
const guest=()=>[env,randomUUID(),'guest-'+id,key,'guest','guest-'+id,key,1,'live',hash,
  1800000000000+day,null,null,null,1800000000000,1800000000000,0,null];
const apple=()=>[env,randomUUID(),'original',key,'apple','apple-'+id,null,1,'live',null,
  null,null,null,null,1000,1000,7,null];
const raw=value=>JSON.stringify(value);
let db;
const byteCount=async value=>(await db.query('SELECT octet_length($1::jsonb::text)::int AS n',[raw(value)])).rows[0].n;
const insertPersona=async tuple=>{
  const result=await db.query(`INSERT INTO listening_v2.privacy_personas(${fields.join(',')})
    VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING persona_id`,tuple);
  // Each accepted vector is independent. Preserve the real live-origin UNIQUE
  // constraint while removing the prior vector before testing the next shape.
  await db.query('DELETE FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2',[tuple[0],tuple[1]]);
  return result;
};
before(async()=>{
  db=new PGlite();
  for(const name of ['001-song-library.sql','021-app-auth.sql','022-live-lyrics-push.sql',
    '025-memberships.sql','029-listening-sessions.sql','030-listening-v2-schema.sql',
    '031-listening-v2-lifecycle-support.sql','032-auth-token-row-locks.sql',
    '033-listening-v2-lifecycle-composition.sql'])
    await db.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
});
after(async()=>{await db?.close();});

test('persona codec counts all eighteen SQL values exactly across UTF8 and JSON escaping',async()=>{
  assert.deepEqual(PRIVACY_CODEC_FIELDS.personaTuple,fields);
  for(const text of ['ascii','中文','français','日本語','한글','🙂','quote"','back\\slash','slash/',
    'line\u2028separator','paragraph\u2029separator','e\u0301']){
    for(const kind of ['guest','apple']){
      const tuple=kind==='guest'?guest():apple();tuple[2]=text;
      if(kind==='guest')tuple[5]=text;
      const value=decodePersonaTuple(raw(tuple));
      assert.deepEqual(value.tuple,tuple);assert.equal(value.normalizedBytes,await byteCount(tuple),text);
      await insertPersona(tuple);
    }
  }
  for(const generation of [0,9,10,99,100,max-1,max]){
    const tuple=apple();tuple[7]=generation;tuple[16]=max;
    const value=decodePersonaTuple(raw(tuple));
    assert.equal(value.normalizedBytes,await byteCount(tuple));await insertPersona(tuple);
  }
});

test('actual eighteen-field CHECK and codec agree at exact512 and513 bytes',async()=>{
  for(const seed of ['plain','quote"','back\\slash','中文🙂']){
    const tuple=apple();tuple[2]=seed;let n=await byteCount(tuple);
    for(const position of [2,3,5]){
      const count=Math.min(512-n,160-Buffer.byteLength(tuple[position]));
      tuple[position]+='z'.repeat(count);n=await byteCount(tuple);
    }
    assert.equal(n,512);assert.equal(decodePersonaTuple(raw(tuple)).normalizedBytes,512);
    await insertPersona(tuple);
    const position=[2,3,5].find(p=>Buffer.byteLength(tuple[p])<160);assert.notEqual(position,undefined);
    const tooLarge=tuple.slice();tooLarge[1]=randomUUID();tooLarge[position]+='z';
    assert.equal(await byteCount(tooLarge),513);
    assert.throws(()=>decodePersonaTuple(raw(tooLarge)),{code:'invalid_request'});
    await assert.rejects(insertPersona(tooLarge),{code:'23514'});
  }
});

test('mandatory terminal reserve equals SQL bytes for exact identities, rollover and transfer targets',async()=>{
  const cases=[guest(),apple()];
  for(const generation of [0,9,99,max-1]){const tuple=apple();tuple[7]=generation;cases.push(tuple);}
  for(const tuple of cases){
    const terminal=tuple.slice();terminal[7]++;terminal[8]='withdrawn';terminal[11]=max;
    terminal[12]=max;terminal[13]=privacyScrubMarker(id,'grants-approver');terminal[15]=max;
    const actual=decodePersonaTuple(raw(tuple),{reserveFuture:true});
    assert.equal(actual.futureNormalizedBytes,Math.max(await byteCount(tuple),await byteCount(terminal)));
    assert.ok(actual.futureNormalizedBytes<=512);await insertPersona(terminal);
  }
  const source=guest(),target=source.slice();target[4]='apple';target[5]='apple-'+id;target[6]=null;
  target[7]++;target[9]=null;target[10]=null;target[16]=max;target[17]=source[7];
  const terminal=target.slice();terminal[7]++;terminal[8]='withdrawn';terminal[11]=max;
  terminal[12]=max;terminal[13]=privacyScrubMarker(id,'rooms');terminal[15]=max;
  assert.equal(decodePersonaTuple(raw(target),{reserveFuture:true}).futureNormalizedBytes,
    Math.max(await byteCount(target),await byteCount(terminal)));
  // SQL initial INSERT is deliberately stricter than snapshot decoding: a
  // bridge is legal only in a source-locked OLD->NEW transfer, never fabricated.
  await assert.rejects(insertPersona(target),{code:'23514'});
  const exhausted=apple();exhausted[7]=max;
  assert.throws(()=>decodePersonaTuple(raw(exhausted),{reserveFuture:true}),{code:'invalid_request'});
});

async function insertDependency(payload){
  const jobID=randomUUID();return db.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,payload,
    created_at_ms,due_at_ms,retry_until_ms) VALUES($1,$2,$3,'privacy_dependency',$4,$5,$5,$6) RETURNING job_id`,
    [payload.environment,jobID,'privacy-dependency:'+jobID,payload,2000,2000+day]);
}
test('EXACT031 payload and full future cursor counts agree with actual JSONB and constraints',async()=>{
  for(const selector of [{kind:'credential',value:hash},{kind:'guest-key',value:key},
    {kind:'guest-user',value:'guest-中文'},{kind:'apple-controller',value:'apple-quote"\\'},
    {kind:'indexed-sweep'}]){
    const payload={version:2,environment:env,selector,cursor:null,
      invalidatedAtMS:selector.kind==='indexed-sweep'?null:1000};
    const value=decodePrivacyDependency(raw(payload));
    assert.equal(value.normalizedBytes,await byteCount(payload));
    const count=(await db.query(`SELECT octet_length(jsonb_set($1::jsonb,'{cursor}',
      jsonb_build_array(repeat('x',128),'ffffffff-ffff-ffff-ffff-ffffffffffff'))::text)::int AS n`,[raw(payload)])).rows[0].n;
    assert.equal(value.futureNormalizedBytes,count);await insertDependency(payload);
  }
  const oversized={version:2,environment:'preview:'+'e'.repeat(120),selector:{kind:'guest-user',value:'v'.repeat(160)},
    cursor:['preview:'+'c'.repeat(120),id],invalidatedAtMS:1000};
  assert.ok(await byteCount(oversized)>512);
  assert.throws(()=>decodePrivacyDependency(raw(oversized)),{code:'invalid_request'});
  await assert.rejects(insertDependency(oversized),{code:'23514'});
});

test('all eight scrub phases preserve complete suffixes and match SQL JSONB byte counts',async()=>{
  const cursors={rooms:id,'grants-host':id,'grants-guest':id,'grants-approver':id,
    events:[id,30001],receipts:[id,hash,'b'.repeat(64),'00000000-0000-0000-0000-000000000002'],
    assets:[id,9,max,'00000000-0000-0000-0000-000000000003'],complete:null};
  for(const [phase,cursor] of Object.entries(cursors)){
    const payload={version:2,environment:env,personaID:id,privacyGeneration:9,withdrawnAtMS:1000,
      scrubDueAtMS:1000+day,phase,cursor};
    const actual=decodePrivacyScrub(raw(payload));
    assert.deepEqual(actual.payload,payload);assert.equal(actual.normalizedBytes,await byteCount(payload));
    assert.equal(Buffer.byteLength(privacyScrubMarker(id,phase)),41);
  }
});

test('every codec-admitted identifier in the locale sample satisfies actual SQL control/space checks',async t=>{
  const conservative=[];
  for(const text of ['a b','a\tb','a\u007fb','a\u0085b','a\u009fb','a\u00a0b','a\u1680b',
    'a\u2000b','a\u200bb','a\u2028b','a\u202fb','a\u3000b','quote"\\中文']){
    const row=(await db.query(`SELECT $1::text !~ '[[:cntrl:]]' AS persona_ok,
      $1::text !~ '[[:space:][:cntrl:]]' AS selector_ok`,[text])).rows[0];
    const tuple=apple();tuple[2]=text;
    let accepted=true;try{decodePersonaTuple(raw(tuple));}catch(error){assert.equal(error.code,'invalid_request');accepted=false;}
    if(accepted)assert.equal(row.persona_ok,true,'codec must not admit SQL-forbidden persona identity');
    else if(row.persona_ok)conservative.push(['persona',raw(text)]);
    const payload={version:2,environment:env,selector:{kind:'guest-user',value:text},cursor:null,invalidatedAtMS:1000};
    accepted=true;try{decodePrivacyDependency(raw(payload));}catch(error){assert.equal(error.code,'invalid_request');accepted=false;}
    if(accepted)assert.equal(row.selector_ok,true,'codec must not admit SQL-forbidden selector');
    else if(row.selector_ok)conservative.push(['selector',raw(text)]);
  }
  // Conservative refusal is reported explicitly rather than claiming that JS
  // Unicode classes equal every deployed PostgreSQL collation/ctype setting.
  t.diagnostic(JSON.stringify({conservativeRefusals:conservative,scope:'local PGlite locale only'}));
});
