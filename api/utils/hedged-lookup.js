// At most two lookups run at once. Only the caller's validated results compete.
// Timed lyrics win immediately; untimed lyrics leave a short window for timing.
export function hedgedLookup(apis, lookup, {delayMs=350, untimedGraceMs=350}={}) {
  return new Promise(resolve=> {
    let next=0, active=0, finished=false, untimed=null, hedgeTimer, graceTimer;
    const controllers=new Set();
    const finish=value=> {
      if(finished) return;
      finished=true; clearTimeout(hedgeTimer); clearTimeout(graceTimer);
      for(const controller of controllers) controller.abort();
      resolve(value);
    };
    const launch=()=> {
      if(finished || next>=apis.length || active>=2) return;
      const api=apis[next++],controller=new AbortController();
      controllers.add(controller); active++;
      Promise.resolve().then(()=>lookup(api,controller.signal)).catch(()=>null).then(result=> {
        controllers.delete(controller); active--;
        if(finished) return;
        if(result) {
          if(result.lyrics.lines.some(line=>Number.isFinite(line.timestamp) && line.timestamp>=0)) { finish(result); return; }
          if(!untimed) { untimed=result; graceTimer=setTimeout(()=>finish(untimed),untimedGraceMs); }
        }
        launch();
        if(active===0 && next>=apis.length) finish(untimed);
      });
    };
    if(!apis.length) { finish(null); return; }
    launch();
    hedgeTimer=setTimeout(launch,delayMs);
  });
}
