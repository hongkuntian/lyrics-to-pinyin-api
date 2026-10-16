import {normalizeRecordingText,normalizedAlbum,recordingScore} from './recording-match.js';
import {withDeadline} from './fetch-json.js';
import {sourceTarget} from './verified-lyric-context.js';
const sameTarget=(a,b)=>JSON.stringify(sourceTarget(a))===JSON.stringify(sourceTarget(b));
export function freshHintMatches(hint,fresh,target){
 const song=fresh?.song,previous=hint?.signature;
 return Boolean(song&&fresh.lyrics&&String(song.id)===hint.id&&previous
  &&['artist','title'].every(k=>typeof song[k]==='string'&&normalizeRecordingText(song[k])===normalizeRecordingText(previous[k]??''))
  &&(previous.album==null?song.album==null:typeof song.album==='string'&&normalizedAlbum(song.album)===normalizedAlbum(previous.album))
  &&Number.isFinite(song.duration)&&Number.isFinite(previous.duration)&&Math.abs(song.duration-previous.duration)<=0.5
  &&['isrc','explicit','creditedArtistNames'].every(k=>previous[k]===undefined||JSON.stringify(previous[k])===JSON.stringify(song[k]))
  &&recordingScore(song,target)>=0);
}
export async function hintedRecording(api,target,context,{signal,deadline,budgetMs=800,measure=async(_,fn)=>fn()}={}){
 try {
  const hint=Array.isArray(context?.hints)?context.hints.find(h=>h&&h.target&&h.provider===api.name&&sameTarget(h.target,target)):null;
  if(!hint||typeof api.getRecording!=='function')return null;
  const remaining=Math.min(budgetMs,deadline-Date.now());if(remaining<=0)return null;
  const fresh=await measure(`${api.name}_source_id`,()=>withDeadline(child=>api.getRecording(hint.id,{...target,signal:child}),remaining,signal));
  return freshHintMatches(hint,fresh,target)?fresh:null;
 }catch{return null;}
}
