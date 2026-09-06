import fetch from 'node-fetch';
export async function fetchJSON(url, {signal, fetchFn=fetch}={}) {
  const response=await fetchFn(url,{signal});
  if (!response.ok) throw new Error(`Lyrics provider returned HTTP ${response.status}`);
  return response.json();
}
export async function withDeadline(operation, milliseconds = 6000) {
  const controller=new AbortController();
  let timer;
  try {
    return await Promise.race([operation(controller.signal),new Promise((_,reject)=> {
      timer=setTimeout(()=> {
        controller.abort();
        const error=new Error('Lyrics provider timed out'); error.code='provider_timeout'; reject(error);
      },milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
