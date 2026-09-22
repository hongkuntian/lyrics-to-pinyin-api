import {waitUntil} from '@vercel/functions';
import {createMusicRomanizeHandler,SELECTION_REVISION} from './music-romanize.js';
import {SongLibraryStore,LibraryError} from './utils/song-library/store.js';
import {database} from './utils/song-library/database.js';
import {makeDocument,recordingRequest,requestKey} from './utils/song-library/document.js';
import {generate,requestBody,reservationMicros,LEGACY_RECIPE,translationRecipe} from './utils/song-library/translation.js';
import {publicDocument,publicTranslation} from './utils/song-library/public-content.js';

import {canonicalTarget,environmentLanguagePolicy,requireDirection,capabilities} from './utils/song-library/languages.js';
import {selectionV2,explanationRecipe,selectionFor,explanationBody,explanationKey,generateExplanation} from './utils/song-library/study-explanation.js';
import {reserveExplanation,claimExplanation,finishExplanation,publicExplanation} from './utils/song-library/study-store.js';

import {annotationFor,pronunciationKey,enabledProfiles} from './utils/pronunciation-aids.js';

export const config={maxDuration:300};
const actions={capabilities:[],pronunciation:['documentID','sourceHash','profileID'],explain:['documentID','sourceHash','translationID','sourceID','lower','upper','contractVersion','studyText','selection','explanationLanguage','contextTranslation'],lyrics:['recording'],translate:['documentID','sourceHash','target'],current:['documentID','sourceHash','revisionID','target'],status:['jobID'],report:['documentID','translationID','sourceID','category','detail']};
export function lyricLoader(handler=createMusicRomanizeHandler()) {
  return async recording=> {
    const result={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',body:{...recording,options:{tone_style:'marks',separator:' ',case:'lower'}}},result);
    if(result.code!==200) throw new LibraryError(result.body?.code??'lyrics_unavailable',result.code);
    return result.body;
  };
}
export function createSongLibraryHandler({store,loadLyrics=lyricLoader(),generateFn=generate,explainFn=generateExplanation,apiKey=process.env.OPENAI_API_KEY,
  selectionRevision=SELECTION_REVISION,waitUntilFn=waitUntil,logger=console,languagePolicy=null,pronunciationFn=annotationFor,pronunciationProfiles=enabledProfiles}={}) {
  const getStore=()=>store??new SongLibraryStore(database());
  async function execute(db,id,doc) {
    const claimed=await db.claim(id);if(!claimed)return;
    try {
      // An old queued job has only the frozen English recipe; never reinterpret it.
      if(!claimed.generation_request&&(claimed.target!=='en'||claimed.recipe!==LEGACY_RECIPE))throw new LibraryError('generation_configuration_unavailable');
      const result=await generateFn(doc,{apiKey,target:claimed.target,generationRequest:claimed.generation_request??requestBody(doc,'en',{legacy:true})});
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
      const policy=languagePolicy??environmentLanguagePolicy();
      if(input.action==='capabilities')return send(200,{capabilities:{...capabilities(policy),pronunciation:{contractVersion:1,profiles:pronunciationProfiles()}}});
      if(input.action==='pronunciation') {
        if(typeof input.documentID!=='string'||!/^[a-f0-9]{64}$/.test(input.documentID)||typeof input.sourceHash!=='string'||typeof input.profileID!=='string')throw new LibraryError('invalid_request',400);
        const doc=await db.document(input.documentID);if(!doc)throw new LibraryError('document_not_found',404);
        if(doc.sourceHash!==input.sourceHash)throw new LibraryError('source_changed');
        const key=pronunciationKey(doc,input.profileID);
        // A disabled profile remains cached offline; no new server work is admitted.
        if(!pronunciationProfiles().some(p=>p.id===input.profileID))throw new LibraryError('unsupported_pronunciation_profile',422);
        let row=(await db.db.query('SELECT annotation FROM pronunciation_aids WHERE id=$1',[key])).rows[0];
        if(!row){
          const value=await pronunciationFn(doc,input.profileID);
          if(value.id!==key||value.documentID!==doc.id||value.sourceHash!==doc.sourceHash)throw new LibraryError('invalid_pronunciation_result',502);
          await db.db.query(`INSERT INTO pronunciation_aids(id,document_id,source_hash,profile_id,profile_version,engine_version,annotation)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[key,doc.id,doc.sourceHash,value.profile.id,value.profile.version,value.profile.engineVersion,JSON.stringify(value)]);
          row=(await db.db.query('SELECT annotation FROM pronunciation_aids WHERE id=$1',[key])).rows[0];
        }
        return send(200,{state:'ready',pronunciation:row.annotation});
      }
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
      if(input.action==='translate'||input.action==='current') {
        if(typeof input.documentID!=='string'||!/^[a-f0-9]{64}$/.test(input.documentID)||typeof input.sourceHash!=='string') throw new LibraryError('invalid_request',400);
        const doc=await db.document(input.documentID);if(!doc)throw new LibraryError('document_not_found',404);
        if(doc.sourceHash!==input.sourceHash)throw new LibraryError('source_changed');
        const target=canonicalTarget(input.target);
        const saved=await db.translation(doc.id,target);
        // Revision checks never reserve money, queue generation, or require an OpenAI key.
        if(input.action==='current') {
          if(input.revisionID!==undefined&&(typeof input.revisionID!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.revisionID)))
            throw new LibraryError('invalid_request',400);
          if(!saved)return send(200,{state:'missing',target,documentID:doc.id,sourceHash:doc.sourceHash});
          if(saved.id===input.revisionID)return send(200,{state:'unchanged',revisionID:saved.id,target,documentID:doc.id,sourceHash:doc.sourceHash});
          return send(200,{state:'ready',translation:publicTranslation(saved,doc)});
        }
        if(saved)return send(200,{state:'ready',translation:publicTranslation(saved,doc)});
        if(!await db.isCurrentDocument(doc.id,selectionRevision))throw new LibraryError('source_revision_superseded');
        if(!apiKey)throw new LibraryError('generation_not_configured',503);
        requireDirection(policy,'translation',doc.response.song.language,target);
        const body=requestBody(doc,target);
        const result=await db.reserve({userID:user.id,documentID:doc.id,target,recipe:translationRecipe(target),reservedMicros:reservationMicros(body),generationRequest:body});
        if(result.kind==='ready')return send(200,{state:'ready',translation:publicTranslation(result.translation,doc)});
        if(result.job.state==='queued')waitUntilFn(execute(db,result.job.id,doc).catch(()=>logger.error('translation_worker_storage_failure',{jobID:result.job.id})));
        if(result.kind==='unknown'||result.kind==='failed')return send(409,{state:result.kind,job:result.job,code:result.job.errorCode??'review_required'});
        res.setHeader('Retry-After','3');return send(202,{state:'preparing',job:result.job});
      }
      if(input.action==='explain') {
        const v2=input.contractVersion===2;
        if((input.contractVersion!==undefined&&input.contractVersion!==1&&!v2)||(v2&&typeof input.explanationLanguage!=='string'))throw new LibraryError('invalid_request',400);
        const allowed=v2?['action','documentID','sourceHash','contractVersion','studyText','selection','explanationLanguage','contextTranslation']:
          ['action','documentID','sourceHash','translationID','sourceID','lower','upper','contractVersion'];
        if(Object.keys(input).some(k=>!allowed.includes(k))||typeof input.documentID!=='string'||!/^[a-f0-9]{64}$/.test(input.documentID)||typeof input.sourceHash!=='string')throw new LibraryError('invalid_request',400);
        const doc=await db.document(input.documentID);if(!doc)throw new LibraryError('document_not_found',404);
        if(doc.sourceHash!==input.sourceHash)throw new LibraryError('source_changed');
        const language=canonicalTarget(v2?input.explanationLanguage:'en');
        let saved=null;
        if(!v2) {
          if(typeof input.translationID!=='string')throw new LibraryError('invalid_request',400);
          saved=await db.translation(doc.id,'en');
          if(!saved||saved.id!==input.translationID)throw new LibraryError('translation_revision_superseded');
        } else {
          if(!input.studyText||!['original','translation'].includes(input.studyText.layer))throw new LibraryError('invalid_selection',400);
          const translated=input.studyText.layer==='translation';
          if(translated&&input.contextTranslation!==undefined)throw new LibraryError('invalid_request',400);
          const context=translated?input.studyText:input.contextTranslation;
          if(context!==undefined) {
            if(!context||typeof context!=='object'||Array.isArray(context)||typeof context.target!=='string'||typeof context.revisionID!=='string'||
              (!translated&&Object.keys(context).sort().join()!=='revisionID,target'))throw new LibraryError('invalid_request',400);
            saved=await db.translation(doc.id,canonicalTarget(context.target));
            if(!saved||saved.id!==context.revisionID)throw new LibraryError('translation_revision_superseded');
          }
        }
        const selection=v2?selectionV2(doc,input,saved):selectionFor(doc,input);
        const key=explanationKey(doc,saved,selection,language),recipe=explanationRecipe(selection,language);
        const prior=(await db.db.query('SELECT * FROM study_explanations WHERE cache_key=$1',[key])).rows[0];
        let row=prior;
        if(!row) {
          requireDirection(policy,'explanation',selection.studyText?.layer==='translation'?saved.target:doc.response.song.language,language);
          if(!await db.isCurrentDocument(doc.id,selectionRevision))throw new LibraryError('source_revision_superseded');
          if(!apiKey)throw new LibraryError('generation_not_configured',503);
          const body=explanationBody(doc,saved,selection,language);
          row=(await reserveExplanation(db.db,{key,doc,translation:saved,selection,recipe,userID:user.id,explanationLanguage:language,
            generationRequest:body,amount:reservationMicros(body)})).row;
        }
        if(row.state==='ready')return send(200,{state:'ready',explanation:publicExplanation(row)});
        if(['failed','unknown'].includes(row.state))throw new LibraryError(row.error_code??'review_required');
        if(row.state==='queued')waitUntilFn((async()=>{
          if(!await claimExplanation(db.db,row.id))return;
          try { const result=await explainFn(doc,saved,selection,{apiKey,explanationLanguage:row.explanation_language,
            generationRequest:row.generation_request??explanationBody(doc,saved,selection,'en')});await finishExplanation(db.db,row.id,result); }
          catch(error) { await finishExplanation(db.db,row.id,{actualMicros:error.actualMicros??null,response:error.providerResponse??null,errorCode:error.code??'worker_interrupted'}); }
        })().catch(()=>logger.error('study_worker_storage_failure',{jobID:row.id})));
        res.setHeader('Retry-After','3');return send(202,{state:'preparing'});
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
      // v1 acknowledges receipt with "pending" even when a duplicate report has since been
      // assessed. Its durable disposition remains unchanged and is visible to the dashboard.
      return send(200,{report:{id:report.id,status:'pending'}});
    } catch(error) {
      const known=error instanceof LibraryError;const status=known?error.status:503;
      if(!known)logger.error('song_library_store_unavailable');
      if(status===429)res.setHeader('Retry-After','60');
      return send(status,{code:known?error.code:'store_unavailable'});
    }
  };
}
export default createSongLibraryHandler();
