import {waitUntil} from '@vercel/functions';
import {createMusicRomanizeHandler,SELECTION_REVISION} from './music-romanize.js';
import {SongLibraryStore,LibraryError} from './utils/song-library/store.js';
import {database} from './utils/song-library/database.js';
import {makeDocument,recordingRequest,requestKey} from './utils/song-library/document.js';
import {generate,requestBody,reservationMicros,RECIPE} from './utils/song-library/translation.js';
import {publicDocument,publicTranslation} from './utils/song-library/public-content.js';

export const config={maxDuration:300};
const actions={lyrics:['recording'],translate:['documentID','sourceHash'],status:['jobID'],report:['documentID','translationID','sourceID','category','detail']};
export function lyricLoader(handler=createMusicRomanizeHandler()) {
  return async recording=> {
    const result={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',body:{...recording,options:{tone_style:'marks',separator:' ',case:'lower'}}},result);
    if(result.code!==200) throw new LibraryError(result.body?.code??'lyrics_unavailable',result.code);
    return result.body;
  };
}
export function createSongLibraryHandler({store,loadLyrics=lyricLoader(),generateFn=generate,apiKey=process.env.OPENAI_API_KEY,
  selectionRevision=SELECTION_REVISION,waitUntilFn=waitUntil,logger=console}={}) {
  const getStore=()=>store??new SongLibraryStore(database());
  async function execute(db,id,doc) {
    const claimed=await db.claim(id);if(!claimed)return;
    try {
      const result=await generateFn(doc,{apiKey});
      await db.complete(id,result.content,result.actualMicros,result.response);
    } catch(error) {
      // A timeout/storage interruption never releases money or starts a second provider request.
      await db.fail(id,error.code??'worker_interrupted',error.actualMicros??null,error.providerResponse??null);
    }
  }
  return async(req,res)=> {
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    const send=(status,body)=>res.status(status).json({version:1,...body});
    if(req.method!=='POST') {res.setHeader('Allow','POST');return send(405,{code:'method_not_allowed'});}
    try {
      const input=req.body;
      if(!input||Array.isArray(input)||typeof input!=='object'||Buffer.byteLength(JSON.stringify(input))>8192||
        !Object.hasOwn(actions,input.action)||Object.keys(input).some(k=>k!=='action'&&!actions[input.action].includes(k))) throw new LibraryError('invalid_request',400);
      const token=req.headers?.authorization?.match(/^Bearer ([A-Za-z0-9_-]{6,256})$/)?.[1];
      if(!token) throw new LibraryError('unauthorized',401);
      const db=getStore(),user=await db.authenticate(token);if(!user) throw new LibraryError('unauthorized',401);
      await db.rateLimit(user.id);
      if(input.action==='lyrics') {
        const recording=recordingRequest(input.recording),key=requestKey(recording);
        let doc=await db.documentForRequest(key,selectionRevision);
        if(!doc) {
          const owner=await db.claimLookup(key,selectionRevision);
          if(!owner) {res.setHeader('Retry-After','2');return send(202,{state:'loading_lyrics'});}
          try {
            doc=await db.documentForRequest(key,selectionRevision);
            if(!doc) doc=await db.saveDocument(makeDocument(recording,await loadLyrics(recording),selectionRevision));
          } finally {await db.releaseLookup(key,selectionRevision,owner);}
        }
        return send(200,{state:'ready',document:publicDocument(doc)});
      }
      if(input.action==='translate') {
        if(typeof input.documentID!=='string'||!/^[a-f0-9]{64}$/.test(input.documentID)||typeof input.sourceHash!=='string') throw new LibraryError('invalid_request',400);
        const doc=await db.document(input.documentID);if(!doc)throw new LibraryError('document_not_found',404);
        if(doc.sourceHash!==input.sourceHash)throw new LibraryError('source_changed');
        const saved=await db.translation(doc.id,'en');
        if(saved)return send(200,{state:'ready',translation:publicTranslation(saved,doc)});
        if(!await db.isCurrentDocument(doc.id,selectionRevision))throw new LibraryError('source_revision_superseded');
        if(!apiKey)throw new LibraryError('generation_not_configured',503);
        const result=await db.reserve({userID:user.id,documentID:doc.id,target:'en',recipe:RECIPE,reservedMicros:reservationMicros(requestBody(doc))});
        if(result.kind==='ready')return send(200,{state:'ready',translation:publicTranslation(result.translation,doc)});
        if(result.job.state==='queued')waitUntilFn(execute(db,result.job.id,doc).catch(()=>logger.error('translation_worker_storage_failure',{jobID:result.job.id})));
        if(result.kind==='unknown'||result.kind==='failed')return send(409,{state:result.kind,job:result.job,code:result.job.errorCode??'review_required'});
        res.setHeader('Retry-After','3');return send(202,{state:'preparing',job:result.job});
      }
      if(input.action==='status') {
        if(typeof input.jobID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.jobID))throw new LibraryError('invalid_request',400);
        const job=await db.job(input.jobID);if(!job)throw new LibraryError('job_not_found',404);
        const saved=job.state==='ready'?await db.translation(job.documentID,job.target):null;
        const doc=saved?await db.document(job.documentID):null;
        if(saved&&!doc)throw new LibraryError('document_not_found',404);
        return send(200,{state:job.state,job,...(saved?{translation:publicTranslation(saved,doc)}:{})});
      }
      const report=await db.report({userID:user.id,documentID:input.documentID,translationID:input.translationID,
        sourceID:input.sourceID,category:input.category,detail:input.detail});
      return send(200,{report});
    } catch(error) {
      const known=error instanceof LibraryError;const status=known?error.status:503;
      if(!known)logger.error('song_library_store_unavailable');
      if(status===429)res.setHeader('Retry-After','60');
      return send(status,{code:known?error.code:'store_unavailable'});
    }
  };
}
export default createSongLibraryHandler();
