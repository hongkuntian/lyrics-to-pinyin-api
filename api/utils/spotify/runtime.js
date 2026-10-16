import {authPolicy} from '../app-auth/store.js';
import {publicTranslation} from '../song-library/public-content.js';
import {createSongLibraryService} from '../../song-library.js';
import {SongLibraryStore,LibraryError} from '../song-library/store.js';
import {admitMemberRelay} from '../membership/store.js';
import {createAPNsSender,sendAPNs} from '../live-lyrics/apns.js';
import {SpotifyStore} from './store.js';
import {SpotifyService} from './service.js';
import {spotifyConfiguration,contentFingerprint} from './vault.js';
import {createSpotifyProvider} from './provider.js';
import {enqueue} from './queue.js';
import {checkSpotifyEligibility} from './eligibility.js';
export function createAcquirer(service=createSongLibraryService()){
 return async(recording,user)=>{
  let status=200,body,headers={};const res={setHeader(k,v){headers[k.toLowerCase()]=v;},status(value){status=value;return this;},json(value){body=value;return this;}};
  await service({method:'POST',lyricaUser:user,body:{action:'lyrics',recording}},res);
  return {status,...body,retryAfterMS:Number(headers['retry-after']??2)*1000};
 };
}
export function createSpotifyRuntime({env=process.env,store=new SpotifyStore(),...overrides}={}){
 const config=overrides.config??spotifyConfiguration(env);if(!overrides.config)store.policy=authPolicy(env);const library=new SongLibraryStore(store.db);
 const send=createAPNsSender({env,send:request=>sendAPNs(request)});
 return new SpotifyService({store,config,provider:createSpotifyProvider({clientID:config.clientID}),enqueue,send,
  acquire:createAcquirer(createSongLibraryService({store:library})),eligible:(c,input)=>checkSpotifyEligibility(store.db,c.ownerID,input),admit:(c,input)=>admitMemberRelay(store.db,c.ownerID,input),
  resolveRecipe:async(c,recipe,doc)=>{
   const result={validatedAid:null,validatedTranslation:null,validatedCorrection:false};if(!doc)return result;
   const binding=doc.recordingBinding;
   const correction=recipe.timingCorrection;
   // A correction is explicit scoped app data, bound to the exact recording/source.
   if(correction&&correction.recordingKey===binding?.recordingKey&&correction.sourceHash===doc.sourceHash&&correction.timingRevision===doc.timingRevision&&typeof correction.correctionRevision==='string')result.validatedCorrection=true;
   const ready=recipe.readyTranslation;
   if(ready&&ready.documentID===doc.id&&ready.sourceHash===doc.sourceHash&&ready.textRevision===doc.textRevision&&ready.target===recipe.translationTarget){
    const translation=await library.translation(doc.id,ready.target);
    const storedDocument=await library.document(doc.id),translationDTO=translation&&storedDocument?publicTranslation(translation,storedDocument):null;
    const ownerJob=(await store.db.query(`SELECT 1 FROM translation_jobs j JOIN translation_document_bindings b ON b.translation_id=j.id WHERE j.user_id=$1 AND j.state='ready' AND b.document_id=$2 LIMIT 1`,[c.ownerID,doc.id])).rows[0];
    if(ownerJob&&translation&&translation.id===ready.translationID&&translation.sourceHash===doc.sourceHash&&translation.recipe===ready.recipeVersion&&translationDTO&&contentFingerprint(translationDTO)===ready.contentFingerprint)result.validatedTranslation={documentID:doc.id,sourceHash:doc.sourceHash,lines:translationDTO.lines.map(line=>({sourceID:line.sourceID,translation:line.text??line.translation??''}))};
   }
   const aid=recipe.deviceAid;
   if(aid&&aid.recordingKey===binding?.recordingKey&&aid.sourceHash===doc.sourceHash&&aid.textRevision===doc.textRevision&&aid.readingRevision===doc.readingRevision){
    const annotation=(await store.db.query('SELECT annotation FROM pronunciation_aids WHERE id=$1 AND document_id=$2 AND source_hash=$3 AND profile_id=$4 AND profile_version=$5',[aid.referenceID,doc.id,doc.sourceHash,aid.profileID,aid.profileVersion])).rows[0]?.annotation;
    if(annotation&&contentFingerprint(annotation)===aid.contentFingerprint)result.validatedAid={sourceHash:doc.sourceHash,textRevision:doc.textRevision,readingRevision:doc.readingRevision,lines:annotation.lines.map(line=>({sourceID:line.sourceID,pronunciation:line.text}))};
   }
   return result;
  },...overrides});
}
