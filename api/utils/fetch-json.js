import fetch from 'node-fetch';
import {setTimeout as delay} from 'node:timers/promises';
// Retry-After is a minimum wait, never a delay to truncate and retry early.
// Long/missing rate-limit waits yield to provider fallback within our deadline.
function retryAfterMilliseconds(response) {
  const value=response.headers?.get?.('retry-after');
  if(value==null || !String(value).trim()) return null;
  const text=String(value).trim();
  const milliseconds=/^\d+(?:\.\d+)?$/.test(text) ? Number(text)*1000 : Date.parse(text)-Date.now();
  return Number.isFinite(milliseconds) && milliseconds>=0 && milliseconds<=1000 ? milliseconds:null;
}
export async function fetchJSON(url, {signal, fetchFn=fetch,headers={}}={}) {
  const init={signal,headers:{'User-Agent':'Lyra/2.3.0',...headers}};
  let response=await fetchFn(url,init);
  const retryMs=!response.ok && [502,503,504].includes(response.status) ? 150
    :!response.ok && response.status===429 ? retryAfterMilliseconds(response):null;
  if(retryMs!=null) {
    // One retry shares the caller's deadline and cancellation budget.
    await delay(retryMs,undefined,{signal});
    response=await fetchFn(url,init);
  }
  if (!response.ok) {
    const error=new Error(`Lyrics provider returned HTTP ${response.status}`);
    error.status=response.status;
    throw error;
  }
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
