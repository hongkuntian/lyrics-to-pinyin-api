import {normalizeRecordingText,normalizedAlbum,recordingScore} from './recording-match.js';
import {withDeadline} from './fetch-json.js';
import {sourceTarget} from './verified-lyric-context.js';
import {sameNetEaseTitleEvidence} from './netease-title-evidence.js';
const sameTarget=(a,b)=>JSON.stringify(sourceTarget(a))===JSON.stringify(sourceTarget(b));
// Ordering only: the hint cannot add a target or supply catalog proof.
export function prioritizeHintedTargets(targets,context) {
 const hint=context?.hints?.find(h=>h?.provider==='NeteaseAPI'&&h.target);
 if(!hint)return targets;
 const index=targets.findIndex(t=>sameTarget(hint.target,t));
 return index>0?[targets[index],...targets.slice(0,index),...targets.slice(index+1)]:targets;
}
export function freshHintMatches(hint,fresh,target){
 const song=fresh?.song,previous=hint?.signature;
 return Boolean(song&&fresh.lyrics&&String(song.id)===hint.id&&previous
  &&['artist','title'].every(k=>typeof song[k]==='string'&&normalizeRecordingText(song[k])===normalizeRecordingText(previous[k]??''))
  &&(previous.album==null?song.album==null:typeof song.album==='string'&&normalizedAlbum(song.album)===normalizedAlbum(previous.album))
  &&Number.isFinite(song.duration)&&Number.isFinite(previous.duration)&&Math.abs(song.duration-previous.duration)<=0.5
  &&['isrc','explicit','creditedArtistNames'].every(k=>previous[k]===undefined||JSON.stringify(previous[k])===JSON.stringify(song[k]))
  &&sameNetEaseTitleEvidence(previous.neteaseTitleEvidence,song.neteaseTitleEvidence)
  &&recordingScore(song,target)>=0);
}
export async function hintedRecording(api,target,context,{signal,deadline,budgetMs=800,neteaseBudgetMs=2500,measure=async(_,fn)=>fn()}={}){
 try {
  const hint=Array.isArray(context?.hints)?context.hints.find(h=>h&&h.target&&h.provider===api.name&&sameTarget(h.target,target)):null;
  if(!hint||typeof api.getRecording!=='function')return null;
  const remaining=Math.min(['NeteaseAPI','QQMusicAPI'].includes(api.name)?neteaseBudgetMs:budgetMs,deadline-Date.now());if(remaining<=0)return null;
  const fresh=await measure(`${api.name}_source_id`,()=>withDeadline(child=>api.getRecording(hint.id,{...target,signal:child}),remaining,signal));
  return freshHintMatches(hint,fresh,target)?fresh:null;
 }catch{return null;}
}
