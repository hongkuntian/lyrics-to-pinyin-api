import {LibraryError} from './store.js';
import {generate,requestBody,LEGACY_RECIPE} from './translation.js';
export async function executeTranslationJob(store,id,{apiKey,generateFn=generate,doc=null,observer=null}={}) {
  const claimed=await store.claim(id);if(!claimed)return;
  const notify=(event,...args)=>{try{Promise.resolve(observer?.[event]?.(...args)).catch(()=>{});}catch{/* An observer never owns settlement. */}};
  notify('onStart');
  try {
    if(!doc||claimed.document_id!==doc.id)doc=await store.document(claimed.document_id);
    if(!doc)throw new LibraryError('document_not_found');
    if(!claimed.generation_request&&(claimed.target!=='en'||claimed.recipe!==LEGACY_RECIPE))throw new LibraryError('generation_configuration_unavailable');
    const result=await generateFn(doc,{apiKey,target:claimed.target,generationRequest:claimed.generation_request??requestBody(doc,'en',{legacy:true}),...(observer?{onLine:line=>notify('onLine',line)}:{})});
    await store.complete(claimed.id,result.content,result.actualMicros,result.response,claimed.attempt??null);
    return {claimed:true,state:'ready'};
  } catch(error) {
    await store.fail(claimed.id,error.code??'worker_interrupted',error.actualMicros??null,error.providerResponse??null,claimed.attempt??null);
    return {claimed:true,state:'failed',code:error.code??'worker_interrupted'};
  }
}
