import {normalizeRecordingText,recordingScore,sameRecordingNames} from './recording-match.js';
import {isLatinScriptFallback} from './lyric-script.js';

const normalizedRows=candidate=>(candidate?.lyrics?.lines??[]).map(line=>normalizeRecordingText(line.text??'')).filter(Boolean);

export function needsCompletenessDiscovery(candidate) {
 const lyrics=candidate?.lyrics,duration=candidate?.target?.duration??candidate?.song?.duration;
 if(!lyrics||lyrics.instrumental||lyrics.partial||!Number.isFinite(duration)||duration<=0)return false;
 const rows=(lyrics.lines??[]).filter(line=>line.text?.trim());
 const times=rows.filter(line=>Number.isFinite(line.timestamp)&&line.timestamp>=0&&line.timestamp<=duration)
  .map(line=>Math.max(line.timestamp,Number.isFinite(line.vocalTiming?.end)&&line.vocalTiming.end<=duration?line.vocalTiming.end:line.timestamp));
 if(!rows.length||times.length/rows.length<0.8||normalizedRows(candidate).join('').length<60)return false;
 const last=Math.max(...times);
 return last<duration*0.6&&duration-last>=45;
}

function sameValidatedRecording(excerpt,alternative) {
 const left=excerpt?.target,right=alternative?.target;
 if(!left||!right||!Number.isFinite(left.duration)||!Number.isFinite(right.duration)||Math.abs(left.duration-right.duration)>3)return false;
 const sharedTarget=excerpt.recordingTarget&&excerpt.recordingTarget===alternative.recordingTarget;
 if(left!==right&&!sharedTarget&&(!sameRecordingNames(left,right)||(left.catalog_id&&right.catalog_id&&left.catalog_id!==right.catalog_id)))return false;
 return [excerpt,alternative].every(candidate=>Number.isFinite(candidate.song?.duration)
  &&Math.abs(candidate.song.duration-candidate.target.duration)<=3&&recordingScore(candidate.song,candidate.target)>=0);
}

export function qualifyLyricCompleteness(candidate,alternative) {
 if(!needsCompletenessDiscovery(candidate)||!alternative?.lyrics||alternative.lyrics.partial||alternative.lyrics.instrumental
  ||isLatinScriptFallback(alternative)||!sameValidatedRecording(candidate,alternative))return candidate;
 const rows=normalizedRows(candidate),shortLength=rows.join('').length,full=normalizedRows(alternative).join('');
 if(full.length<shortLength*1.5||full.length-shortLength<80)return candidate;
 let cursor=0,matched=0;
 for(const row of rows) {
  const position=full.indexOf(row,cursor);
  if(position<0)continue;
  matched+=row.length;cursor=position+row.length;
 }
 return matched>=shortLength*0.9?{...candidate,lyrics:{...candidate.lyrics,partial:true}}:candidate;
}
