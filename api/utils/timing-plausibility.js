const meaningful=text=>Array.from(text??'').filter(character=>/[\p{L}\p{N}]/u.test(character)).length;
const quarantinedSources=new Set(['kugou:468823329']);
const provider=value=>String(value??'').toLowerCase().replace(/api$/,'');

export function timingRejectionReason(candidate) {
 const {song,lyrics,api}=candidate??{},lines=lyrics?.lines??[];
 if(!lines.some(line=>line.timestamp!=null||line.vocalTiming))return null;
 if(quarantinedSources.has(`${provider(lyrics?.source??api?.name??song?.source)}:${song?.id??lyrics?.songId}`))return 'quarantined_source';
 let comparable=0,collapsed=0,meaningfulCues=0,tinyCues=0;
 for(let index=0;index<lines.length;index++){
  const row=lines[index],characters=meaningful(row.text??row.original);
  const stop=row.vocalTiming?.end??lines[index+1]?.timestamp;
  if(characters>=8&&Number.isFinite(row.timestamp)&&Number.isFinite(stop)&&stop>row.timestamp){
   comparable++;
   if(stop-row.timestamp<0.25&&characters/(stop-row.timestamp)>80)collapsed++;
  }
  for(const cue of row.vocalTiming?.segments??[]){
   if(!meaningful(cue.text))continue;
   meaningfulCues++;
   if(cue.end>cue.start&&cue.end-cue.start<=0.020001)tinyCues++;
  }
 }
 if(collapsed>=3&&collapsed/Math.max(1,comparable)>=0.15)return 'collapsed_lyric_rows';
 if(collapsed>=2&&tinyCues>=12&&tinyCues/Math.max(1,meaningfulCues)>=0.5)return 'collapsed_vocal_cues';
 return null;
}
export function qualifyLyricTiming(candidate) {
 const reason=timingRejectionReason(candidate);
 if(!reason)return candidate;
 const {timingSource,durationResolution,...lyrics}=candidate.lyrics;
 return {...candidate,lyrics:{...lyrics,lines:lyrics.lines.map(({vocalTiming,...row})=>({...row,timestamp:null}))},
  timingCorrection:{id:'temporal-plausibility-1',status:'untimed_fallback',reason}};
}
export function responseTimingNeedsRefresh(response) {
 const source=response?.song_details?.source??response?.metadata?.source??response?.song?.source;
 return Boolean(timingRejectionReason({song:{...response?.song,id:response?.song_details?.source_id??response?.song?.id},
  lyrics:{source,lines:response?.lines??[]}}));
}
