import test from 'node:test';
import assert from 'node:assert/strict';
import {yrcService,appleRequest} from '../helpers/netease-yrc.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {makeDocument,recordingRequest,requestKey} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {libraryDB} from '../helpers/library-db.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {verifiedTimingAlias} from '../../api/utils/vocal-timing.js';
import {catalogProof} from '../helpers/netease-yrc.js';

for(const value of [undefined,null])test(`exact Apple YRC survives an ${value===null?'explicitly null':'omitted'} optional storefront`,async t=>{
 const {storefront,...fields}=appleRequest,request={...fields,...(value===null?{storefront:null}:{})};
 const f=yrcService(),legacy=await f.call(request);
 assert.equal(legacy.statusCode,200);
 assert.equal(legacy.body.metadata.lyric_timing?.recordingID,request.catalog_id);
 assert.equal(legacy.body.lines.filter(l=>l.vocalTiming).length,2);
 const stream=streamResponse();await f.service({method:'POST',body:{...request,options:{refresh:true,delivery:'progressive-v1'}}},stream);
 const emitted=frames(stream).filter(f=>f.response);
 assert.ok(emitted.length>0);
 for(const frame of emitted){
  assert.equal(frame.response.metadata.lyric_timing?.recordingID,request.catalog_id);
  assert.equal(frame.response.lines.filter(l=>l.vocalTiming).length,2);
 }
 const normalized=recordingRequest(request),response=emitted.at(-1).response;
 const doc=makeDocument(normalized,response,SELECTION_REVISION),{db,store}=await libraryDB();t.after(()=>db.close());
 const owner=await store.claimLookup(doc.requestKey,SELECTION_REVISION);assert.ok(owner);
 try{await store.saveDocument(doc,{lookupOwner:owner});}finally{await store.releaseLookup(doc.requestKey,SELECTION_REVISION,owner);}
 const reopened=await store.documentForRequest(requestKey(normalized),SELECTION_REVISION),wire=publicDocument(reopened,normalized);
 assert.deepEqual(wire.response.lines,response.lines);
 assert.deepEqual(wire.response.metadata.lyric_timing,response.metadata.lyric_timing);
});

test('explicit storefront and different-ID alias restrictions stay strict',async()=>{
 const request={...appleRequest,storefront:'gb'},result=await yrcService().call(request);
 assert.equal(result.statusCode,200);
 assert.equal(result.body.lines.some(l=>l.vocalTiming),false);
 assert.equal(result.body.metadata.lyric_timing,undefined);
 const {storefront,...unspecified}=appleRequest;
 assert.equal(verifiedTimingAlias(catalogProof(unspecified),unspecified,'apple:123'),false);
 const proof=catalogProof(appleRequest);
 assert.equal(verifiedTimingAlias(proof,appleRequest,'apple:123'),true);
 for(const changed of [{...appleRequest,catalog_id:'456'},{...appleRequest,title:'Different song'},{...appleRequest,duration:241},{...appleRequest,storefront:'gb'}])
  assert.equal(verifiedTimingAlias(proof,changed,'apple:123'),false);
});
