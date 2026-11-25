// Original synthetic sentences only. No commercial source or model request.
import {POOL} from '../../api/utils/prepared-editions/core.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {prepareReadingAids} from '../../api/utils/prepared-editions/reading-aids.js';
import {acceptedTranslations,inspectorManifest,studyTasks,studyArtifact,assembleBundle} from '../../api/utils/prepared-editions/compiler.js';
import {lineSelections} from '../../api/utils/song-library/study-line.js';
import {selectionV2} from '../../api/utils/song-library/study-explanation.js';
import {allDirections} from './prepared-edition.js';
export async function readingInputs(language){
 const song=POOL[language][0],r=song.recordings[0],variants=song.recordings.map(r=>({provider:'apple',catalogID:r.catalog_id,storefront:r.storefront}));
 const text=language==='ja'?'青い鳥 ABC':'함께 노래해 ABC';
 const response={song:{id:'1',duration:24,language,romanization_system:language==='ja'?'Hepburn':'Revised',title:{original:'Synthetic learning song',romanized:'Synthetic learning song'},artist:{original:'Lyrica fixture',romanized:'Lyrica fixture'}},quality:{synced:true,partial:false,instrumental:false},metadata:{version:'2.5.0',timestamp:'2026-11-25T00:00:00Z',source:'QQMusicAPI',lyric_timing:{version:1,provider:'appleMusic',recordingID:r.catalog_id,source:'qq:1:qrc',revision:'a'.repeat(64)}},lines:[0,1].map(i=>({original:text,romanized:'',timestamp:i*4,vocalTiming:{end:i*4+3,segments:[{utf16Start:0,utf16Length:text.length,text,start:i*4,end:i*4+3}]}}))};
 const doc=await prepareReadingAids(makeDocument(r,response,'test',{}));
 const translations=acceptedTranslations(doc,['en','fr','es','zh-Hans','zh-Hant'].map(target=>({target,content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:target.startsWith('zh')?'一起唱歌':'Sing together',text:target.startsWith('zh')?'一起唱歌':'Sing together',speakerID:null,startsTurn:false})),sourceNotes:[]}})));
 const {rows,...manifest}=inspectorManifest(doc,translations),tasks=studyTasks(doc,translations,manifest,allDirections);
 const studyArtifacts=tasks.map(task=>{
  const s=task.selector,t=s.studyText.layer==='translation'?translations[s.studyText.target]:null;
  const content=task.kind==='batch'?{items:lineSelections(doc,s,t).map(x=>({id:x.id,meaning:'A greeting.',context:'A synthetic sentence.',uncertainty:'',grammar:'',sourceQuote:x.text}))}:{meaning:'A greeting.',context:'A synthetic sentence.',uncertainty:'',grammar:'',sourceQuote:selectionV2(doc,s,t).text};
  return studyArtifact(doc,translations,task,{content});
 });
 const spec={songID:song.id,display:{title:'Synthetic learning song',artist:'Lyrica fixture',duration:24},documentVariant:variants[0],variants,uses:['read','play'],rights:{source:{provider:'qq',itemID:'1'},reference:'synthetic-only-permission',reviewer:'test',acquisition:true,derivatives:true,persistentServing:true,worldwide:true,territories:[],expiresAt:'2099-01-01T00:00:00Z'},acquisitionReview:{reference:'synthetic-only-path',selectionRevision:'test',allOrdinaryProviderPathsApproved:true},recordingEvidence:{documentID:doc.id,sourceHash:doc.sourceHash,variants,reference:'synthetic-only-recording',reviewer:'test',timingVerified:true,listeningVerified:true},parityReference:'synthetic-native-shaped-manifest-not-runtime-proof'};
 return {doc,translations,manifest,tasks,studyArtifacts,spec};
}
export async function readingBundle(language){return assembleBundle(await readingInputs(language));}
