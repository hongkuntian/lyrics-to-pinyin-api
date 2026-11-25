import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSchema} from './schema-validator.js';
import {preparedRequest} from '../../api/utils/prepared-editions/service.js';
import {bundle} from '../helpers/prepared-edition.js';
const request=JSON.parse(await readFile(new URL('../../contracts/prepared-edition-request.schema.json',import.meta.url))),response=JSON.parse(await readFile(new URL('../../contracts/prepared-edition-response.schema.json',import.meta.url)));
test('additive prepared wire matches explicit request/response contracts and ordinary public UUID revisions',async()=>{
 const b=bundle(),row={bundle:b,generation:'1',state:'published'},store={all:async()=>[row],edition:async()=>row,lookup:async()=>row};
 for(const input of [{action:'prepared_starters',languages:['cmn']},{action:'prepared_lookup',variant:b.variants[0],use:'read'},
  {action:'prepared_grant',editionID:b.editionID,generation:'1',use:'read'},
  {action:'prepared_artifact',editionID:b.editionID,generation:'1',use:'play',variant:b.variants[0],artifactID:b.artifacts[0].id}]){
  assert.deepEqual(validateSchema(request,input),[]);assert.deepEqual(validateSchema(response,{version:1,...await preparedRequest(input,{store})}),[]);
 }
 for(const a of b.artifacts){
  if(['translation','batch','explanation'].includes(a.kind))assert.match(a.content.id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  if(['document','manifest'].includes(a.kind))assert.deepEqual(a.selector,{});
 }
 assert.deepEqual(validateSchema(response,{version:1,...await preparedRequest({action:'prepared_lookup',variant:b.variants[0],use:'read'},{store:{lookup:async()=>null}})}),[]);
});
test('list omits an older summary whose every exact mapping has been superseded',async()=>{
 const b=bundle(),old={bundle:{...b,editionID:'a'.repeat(64)},generation:'1',state:'published'},current={bundle:b,generation:'2',state:'published'};
 const result=await preparedRequest({action:'prepared_starters',languages:['cmn']},{store:{all:async()=>[current,old]}});
 assert.equal(result.preparedStarters[0].songs.length,1);assert.equal(result.preparedStarters[0].songs[0].editionID,b.editionID);
});
