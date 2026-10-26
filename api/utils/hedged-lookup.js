import {chooseLyricCandidate,timingQuality,hasCompleteMeasuredVocalTiming,measuredSelectionProtected} from './lyric-selection.js';
// At most two lookups run at once. Only the caller's validated results compete.
// Timed lyrics win immediately; untimed lyrics leave a short window for timing.
export function hedgedLookup(apis, lookup, {delayMs=350, untimedGraceMs=350,wordTimingGraceMs=0,chooseCandidate=chooseLyricCandidate,signal,onCandidate}={}) {
  return new Promise(resolve=> {
    let next=0, active=0, finished=false, untimed=null, hedgeTimer, graceTimer,wordTimer,wordDeadline=null,lineWordStarted=false;
    const controllers=new Map();
    const capableRemaining=()=>[...controllers.values(),...apis.slice(next)].some(api=>api.supportsVocalTiming===true);
    const finish=value=> {
      if(finished) return;
      finished=true; clearTimeout(hedgeTimer); clearTimeout(graceTimer);clearTimeout(wordTimer);signal?.removeEventListener('abort',abort);
      for(const controller of controllers.keys()) controller.abort();
      resolve(value);
    };
    const keepWordOpportunity=(lineTimed=false)=> {
      clearTimeout(graceTimer);
      // Preserve the pre-existing line-to-word opportunity when plain text
      // advances to line timing. Repeated progress within either phase cannot
      // renew it; provider and caller deadlines remain unchanged.
      if(wordDeadline===null||lineTimed&&!lineWordStarted){
        clearTimeout(wordTimer);wordDeadline=Date.now()+wordTimingGraceMs;
        wordTimer=setTimeout(()=>finish(untimed),wordTimingGraceMs);
      }
      lineWordStarted ||= lineTimed;
    };
    const launch=()=> {
      if(finished || next>=apis.length || active>=2) return;
      const api=apis[next++],controller=new AbortController();
      controllers.set(controller,api); active++;
      Promise.resolve().then(()=>lookup(api,controller.signal)).catch(()=>null).then(async result=> {
        controllers.delete(controller); active--;
        if(finished) return;
        // A delayed event-loop turn cannot extend the fixed upgrade window.
        if(wordDeadline!==null&&Date.now()>=wordDeadline){finish(untimed);return;}
        const complete=result&&!result.lyrics.partial&&timingQuality(result).usable;
        if(complete) {
          untimed=chooseCandidate(untimed,result);
          if(wordTimingGraceMs<=0||hasCompleteMeasuredVocalTiming(untimed)||measuredSelectionProtected(untimed)||!capableRemaining())finish(untimed);
          else {
            keepWordOpportunity(true);
            // Readable formatting never holds a lookup slot. At most two
            // existing providers run, with one non-resetting upgrade deadline.
            while(active<2&&next<apis.length&&capableRemaining())launch();
          }
          if(onCandidate)try{await onCandidate(result);}catch{}
          return;
        }
        const continued=result&&!complete;
        if(result) {
          if(!complete) {
            if(!untimed)untimed=result;
            else untimed=chooseCandidate(untimed,result);
            // Plain text is immediately readable too. Its short presentation
            // grace must not abort a capable source inside the already-configured
            // word opportunity. Repeated plain progress cannot reset it.
            if(wordTimingGraceMs>0&&!untimed.lyrics.instrumental&&capableRemaining())keepWordOpportunity();
            else if(wordDeadline===null&&!graceTimer)graceTimer=setTimeout(()=>finish(untimed),untimedGraceMs);
            // Keep the existing provider schedule independent of presentation
            // formatting. This is the same successor launch as below.
            launch();
          }
          if(onCandidate) {try{await onCandidate(result);}catch{finish(untimed);return;}if(finished)return;}
        }
        if(!continued)launch();
        if((active===0 && next>=apis.length)||(wordDeadline!==null&&!capableRemaining())) finish(untimed);
      });
    };
    const abort=()=>finish(untimed);signal?.addEventListener('abort',abort,{once:true});
    if(!apis.length||signal?.aborted) { finish(null); return; }
    launch();
    hedgeTimer=setTimeout(launch,delayMs);
  });
}
