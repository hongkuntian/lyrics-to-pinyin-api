// One acquisition owns identity work; individual provider deadlines only stop
// their own wait. A provider cannot revoke the snapshot needed by another.
export function requestArtistIdentities(resolve,artistIDs,{signal,refresh=false}={}) {
 const controller=new AbortController(),abort=()=>controller.abort();
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let pending;
 return {
  async read({signal:readerSignal}={}) {
   readerSignal?.throwIfAborted();
   if(controller.signal.aborted)return [];
   pending??=Promise.resolve().then(()=>resolve(artistIDs,{signal:controller.signal,refresh})).catch(()=>[]);
   let cancel;
   try {
    const cancelled=new Promise((_,reject)=>{
     cancel=()=>reject(readerSignal.reason??new DOMException('Lookup cancelled','AbortError'));
     readerSignal?.addEventListener('abort',cancel,{once:true});if(readerSignal?.aborted)cancel();
    });
    return structuredClone(await Promise.race([pending,cancelled]));
   }finally{readerSignal?.removeEventListener('abort',cancel);}
  },
  close(){controller.abort();signal?.removeEventListener('abort',abort);}
 };
}
