import {withDeadline} from './fetch-json.js';
export function startSpeculativeDiscovery(api,request,{deadline,timeoutMs,signal,measure=async(_,fn)=>fn()}={}){
 const controller=new AbortController(),startedAt=Date.now();let parent,abort,result;
 const link=next=>{parent?.removeEventListener('abort',abort);parent=next;abort=()=>controller.abort();parent?.addEventListener('abort',abort,{once:true});if(parent?.aborted)abort();};link(signal);
 const finishAt=Math.min(deadline,startedAt+timeoutMs),label=api.name.replace(/[^a-zA-Z0-9_]/g,'');
 const promise=measure(`${label}_speculative_search`,()=>withDeadline(child=>api.searchSong(request.artist,request.title,{album:request.album,duration:request.duration,catalog_id:request.catalog_id,signal:child}),Math.max(1,finishAt-startedAt),controller.signal)).then(song=>(result={song}),error=>(result={error}));
 return {api,request,deadline:finishAt,promise,get result(){return result;},used:false,transferred:false,discarded:false,
  transfer(next){this.transferred=true;link(next);},
  cancel(){controller.abort();parent?.removeEventListener('abort',abort);},
  dispose(){parent?.removeEventListener('abort',abort);}
 };
}
