import {chooseLyricCandidate,timingQuality} from './lyric-selection.js';
// At most two lookups run at once. Only the caller's validated results compete.
// Timed lyrics win immediately; untimed lyrics leave a short window for timing.
export function hedgedLookup(apis, lookup, {delayMs=350, untimedGraceMs=350,signal,onCandidate}={}) {
  return new Promise(resolve=> {
    let next=0, active=0, finished=false, untimed=null, hedgeTimer, graceTimer;
    const controllers=new Set();
    const finish=value=> {
      if(finished) return;
      finished=true; clearTimeout(hedgeTimer); clearTimeout(graceTimer);signal?.removeEventListener('abort',abort);
      for(const controller of controllers) controller.abort();
      resolve(value);
    };
    const launch=()=> {
      if(finished || next>=apis.length || active>=2) return;
      const api=apis[next++],controller=new AbortController();
      controllers.add(controller); active++;
      Promise.resolve().then(()=>lookup(api,controller.signal)).catch(()=>null).then(async result=> {
        controllers.delete(controller); active--;
        if(finished) return;
        const complete=result&&!result.lyrics.partial&&timingQuality(result).usable;
        const continued=result&&!complete;
        if(result) {
          if(!complete) {
            if(!untimed){untimed=result;graceTimer=setTimeout(()=>finish(untimed),untimedGraceMs);}
            else untimed=chooseLyricCandidate(untimed,result);
            // Keep the existing provider schedule independent of presentation
            // formatting. This is the same successor launch as below.
            launch();
          }
          if(onCandidate) {try{await onCandidate(result);}catch{finish(untimed);return;}if(finished)return;}
          if(complete) { finish(chooseLyricCandidate(untimed,result)); return; }
        }
        if(!continued)launch();
        if(active===0 && next>=apis.length) finish(untimed);
      });
    };
    const abort=()=>finish(untimed);signal?.addEventListener('abort',abort,{once:true});
    if(!apis.length||signal?.aborted) { finish(null); return; }
    launch();
    hedgeTimer=setTimeout(launch,delayMs);
  });
}
