import fetch from 'node-fetch';
export async function fetchJSON(url, {signal, fetchFn=fetch}={}) {
  const response=await fetchFn(url,{signal});
  if (!response.ok) throw new Error(`Lyrics provider returned HTTP ${response.status}`);
  return response.json();
}
export async function withDeadline(operation, milliseconds = 6000, parentSignal) {
  const controller=new AbortController();
  let timer, cancel;
  try {
    const cancellation=new Promise((_,reject)=> {
      cancel=()=> { controller.abort(); const error=new Error('Lookup cancelled'); error.name='AbortError'; reject(error); };
      parentSignal?.addEventListener('abort',cancel,{once:true});
      if(parentSignal?.aborted) cancel();
    });
    const timeout=new Promise((_,reject)=> {
      timer=setTimeout(()=> {
        controller.abort();
        const error=new Error('Lyrics provider timed out'); error.code='provider_timeout'; reject(error);
      },milliseconds);
    });
    return await Promise.race([Promise.resolve().then(()=> {
      if(controller.signal.aborted) { const error=new Error('Lookup cancelled'); error.name='AbortError'; throw error; }
      return operation(controller.signal);
    }),timeout,cancellation]);
  } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort',cancel); }
}
