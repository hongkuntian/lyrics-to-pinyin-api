import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {analyzeLyricLanguage} from '../../api/utils/lyric-language.js';
import {qqLanguageObservations,bindProviderLanguageObservations} from '../../api/utils/provider-language-evidence.js';
// Use the full validator already locked by the existing Vercel build tools.
// Resolve through its owner, rather than assuming npm hoisted a new dependency.
const require=createRequire(import.meta.url),nodeRequire=createRequire(require.resolve('@vercel/node/package.json')),
 configRequire=createRequire(nodeRequire.resolve('@vercel/static-config/package.json'));
const Ajv2020=configRequire('ajv/dist/2020.js').default;
const schema=JSON.parse(readFileSync(new URL('../../contracts/provider-language-evidence.schema.json',import.meta.url)));
const outer=JSON.parse(readFileSync(new URL('../../contracts/music-romanize-success.schema.json',import.meta.url)));
const validate=new Ajv2020({strict:true}).compile(schema);
const lines=['Invented test words, never commercial lyrics.'];
const evidence=labels=>bindProviderLanguageObservations({lines:lines.map(text=>({text}))},{source:'qq',id:'123'},
 qqLanguageObservations('123',{track_info:{id:123,language:3},info:{lan:{title:'歌曲语种',content:labels.map((value,i)=>({id:i,value}))}}}),{field:'/data/lyric',format:'lrc'}).providerLanguageEvidence;
const ready=()=>analyzeLyricLanguage(lines,{providerEvidence:evidence(['日语']),providerSource:{provider:'qq',id:'123'}}).provider_evidence;
test('the formal contract is an exact additive nested property on existing v1 language details',()=>{
 const {$schema,title,...embedded}=schema;
 assert.deepEqual(outer.properties.metadata.properties.language_details.properties.provider_evidence,embedded);
 assert.equal(validate(ready()),true,JSON.stringify(validate.errors));
 for(const labels of [[],['印度语'],['未来语'],['日语','韩语']]){
  const value=analyzeLyricLanguage(lines,{providerEvidence:evidence(labels),providerSource:{provider:'qq',id:'123'}}).provider_evidence;
  assert.equal(validate(value),true,JSON.stringify(validate.errors));
 }
});
test('closed evidence schema rejects unknown fields, malformed hashes, states and role claims',()=>{
 for(const mutate of [v=>v.extra=true,v=>v.version='next',v=>v.source.extra=true,v=>v.body.extra=true,
  v=>v.observations[0].secret='bad',v=>v.decision.extra=true,v=>v.semantic_sha256='a',v=>v.body.text_sha256='x'.repeat(64),
  v=>v.decision.status='confirmed',v=>v.body.track_role='verified_audio',v=>v.observations[0].scope='artist',
  v=>v.observations[0].language='xx',v=>v.observations[0].raw.extra=true,
  v=>v.observations.push(...Array(8).fill(v.observations[0]))]){
  const value=ready();mutate(value);assert.equal(validate(value),false,JSON.stringify(value));
 }
});
