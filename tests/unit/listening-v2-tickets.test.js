import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalCommandHash,createCreationTickets} from '../../api/utils/listening-v2/tickets.js';

const key={id:'fixture-key-1',secret:Buffer.alloc(32,23)};
const context={environment:'preview-deployment-123',principalID:'guest-G',keyID:'attest-K',action:'create',
 bodyHash:canonicalCommandHash({provider:'appleMusic',storefront:'us',initialIntent:'none'}),sourceRecapRevision:null};
function fixture(){let time=1700000000000;return {tickets:createCreationTickets({keys:[key],activeKeyID:key.id,now:()=>time}),advance(ms){time+=ms;}};}

test('creation tickets allocate both IDs on the server and verify only the bound intent',()=>{
 const {tickets}=fixture(),first=tickets.issue(context),second=tickets.issue(context);
 assert.notEqual(first.sessionID,second.sessionID);assert.notEqual(first.commandID,second.commandID);
 const verified=tickets.verify(first.ticket,context);
 assert.equal(verified.sessionID,first.sessionID);assert.equal(verified.commandID,first.commandID);
 for(const patch of [{environment:'production'},{principalID:'guest-other'},{keyID:'attest-other'},
  {action:'restart'},{bodyHash:'a'.repeat(64)},{sourceRecapRevision:1}]){
  assert.throws(()=>tickets.verify(first.ticket,{...context,...patch}),{code:'invalid_request'});
 }
 assert.throws(()=>tickets.issue({...context,sessionID:first.sessionID}),{code:'invalid_request'});
 assert.throws(()=>tickets.issue({...context,commandID:first.commandID}),{code:'invalid_request'});
});
test('ten-minute expiry, future issuance and retired signing keys refuse without reissuing',()=>{
 const f=fixture(),value=f.tickets.issue(context);
 f.advance(599999);assert.equal(f.tickets.verify(value.ticket,context).sessionID,value.sessionID);
 f.advance(1);assert.throws(()=>f.tickets.verify(value.ticket,context),{code:'expired'});
 const early=fixture(),future=early.tickets.issue(context);early.advance(-1);
 assert.throws(()=>early.tickets.verify(future.ticket,context),{code:'invalid_request'});
 const rotated=createCreationTickets({keys:[{id:'new',secret:Buffer.alloc(32,32)}],activeKeyID:'new'});
 assert.throws(()=>rotated.verify(value.ticket,context),{code:'invalid_request'});
});
test('tampered payload or MAC and malformed/oversized tokens are rejected',()=>{
 const {tickets}=fixture(),value=tickets.issue(context),parts=value.ticket.split('.');
 const payload=JSON.parse(Buffer.from(parts[0],'base64url').toString());payload.notAfterMS+=600000;
 const changed=Buffer.from(JSON.stringify(payload)).toString('base64url')+'.'+parts[1];
 for(const token of [changed,parts[0]+'.'+Buffer.alloc(32,0).toString('base64url'),'',null,'a'.repeat(4097),value.ticket+'.extra',value.ticket+'=']){
  assert.throws(()=>tickets.verify(token,context),{code:'invalid_request'});
 }
});
test('restart tickets bind the source recap revision and action separately',()=>{
 const {tickets}=fixture(),restart={...context,action:'restart',sourceRecapRevision:12};
 const value=tickets.issue(restart);
 assert.equal(tickets.verify(value.ticket,restart).sourceRecapRevision,12);
 assert.throws(()=>tickets.verify(value.ticket,{...restart,sourceRecapRevision:13}),{code:'invalid_request'});
 assert.throws(()=>tickets.issue({...context,action:'restart'}),{code:'invalid_request'});
 assert.throws(()=>tickets.issue({...context,sourceRecapRevision:12}),{code:'invalid_request'});
});
test('canonical intent hashing sorts object keys while retaining arrays, Unicode and exact values',()=>{
 const left={payload:{title:'千千闋歌',order:['a','b']},expected:{queueRevision:12},action:'queue.move',version:2};
 const reordered={version:2,action:'queue.move',expected:{queueRevision:12},payload:{order:['a','b'],title:'千千闋歌'}};
 assert.equal(canonicalCommandHash(left),canonicalCommandHash(reordered));
 for(const patch of [{...left,payload:{...left.payload,order:['b','a']}},{...left,expected:{queueRevision:13}},
  {...left,payload:{...left.payload,title:'千千阙歌'}}])assert.notEqual(canonicalCommandHash(left),canonicalCommandHash(patch));
 for(const value of [{n:NaN},{n:Infinity},{n:Number.MAX_SAFE_INTEGER+1},{n:undefined},{n:1n},new Date(),{x:'x'.repeat(16385)}]){
  assert.throws(()=>canonicalCommandHash(value),{code:'invalid_request'});
 }
 const cycle={};cycle.self=cycle;assert.throws(()=>canonicalCommandHash(cycle),{code:'invalid_request'});
});
