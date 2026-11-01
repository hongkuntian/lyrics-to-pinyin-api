import {normalizeRecordingText,normalizedAlbum} from './recording-match.js';

const blueBird={titles:['ブルーバード','Blue Bird'],artists:['Ikimonogakari','いきものがかり'],
 album:'Chou Ikimonobakari Tennen Kinen Members Best Selection',duration:215.707,
 evidence:'https://www.uta-net.com/song/66961/',revision:'blue-bird-published-ruby-1',
 spans:[{source:'飛翔いたら',reading:'はばたいたら'},{source:'遊迷',reading:'ゆめ'},{source:'共鳴けて',reading:'あずけて'}]};
const graphemes=text=>Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(text),entry=>entry.segment);
const reviewedSource=recording=>String(recording.source??'').toLowerCase().replace(/api$/,'')==='kugou'&&String(recording.id)==='468823329';
export function reviewedJapaneseSpans(text,recording) {
 if(!recording||!blueBird.titles.some(title=>normalizeRecordingText(title)===normalizeRecordingText(recording.title??''))
  ||!blueBird.artists.some(artist=>normalizeRecordingText(artist)===normalizeRecordingText(recording.artist??''))
  ||!(normalizedAlbum(recording.album??'')===normalizedAlbum(blueBird.album)||(!recording.album&&reviewedSource(recording)))
  ||!Number.isFinite(recording.duration)||Math.abs(recording.duration-blueBird.duration)>1)return [];
 const characters=graphemes(text),spans=[];
 for(let lower=0;lower<characters.length;lower++){
  for(const rule of blueBird.spans){
   const length=graphemes(rule.source).length;
   if(characters.slice(lower,lower+length).join('')!==rule.source)continue;
   spans.push({...rule,lower,upper:lower+length});lower+=length-1;break;
  }
 }
 return spans;
}
export function documentReadingRecording(doc) {
 const response=doc.response,song=response?.song,source=doc.sourceCapsule??doc.selectedSourceCapsule;
 return {title:song?.title?.original,artist:song?.artist?.original,album:song?.album,duration:song?.duration,
  source:source?.provider??response?.song_details?.source??response?.metadata?.source,
  id:source?.itemID??response?.song_details?.source_id??song?.id};
}
