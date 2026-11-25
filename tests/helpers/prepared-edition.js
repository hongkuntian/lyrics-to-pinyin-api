import {makeDocument} from '../../api/utils/song-library/document.js';
import {languagePolicy} from '../../api/utils/song-library/languages.js';
import {acceptedTranslations,inspectorManifest,studyTasks,studyArtifact,assembleBundle} from '../../api/utils/prepared-editions/compiler.js';
export const allDirections=languagePolicy({translation:['*:en','*:fr','*:es','*:zh-Hans','*:zh-Hant'],explanation:['*:en','*:fr','*:es','*:zh-Hans','*:zh-Hant']});
export function preparedInputs({song=null,speaker=false}={}){
 const recording=song?.recordings[0]??{catalog_id:'1817103029',storefront:'ca',title:'test',artist:'test',duration:10};
 const variants=song?song.recordings.map(r=>({provider:'apple',catalogID:r.catalog_id,storefront:r.storefront})):[{provider:'apple',catalogID:'1817103029',storefront:'ca'}];
 const doc=makeDocument(recording,{song:{id:'1',duration:10,language:'en',romanization_system:'none',title:{original:'test',romanized:'test'},artist:{original:'test',romanized:'test'}},quality:{synced:true,partial:false,instrumental:false},metadata:{timestamp:'2026-11-25T00:00:00.000Z',version:'2.5.0',source:'QQMusicAPI',lyric_timing:{version:1,provider:'appleMusic',recordingID:recording.catalog_id,source:'qq:1:qrc',revision:'a'.repeat(64)}},lines:[{original:speaker?'A: Hi':'Hi',romanized:'Hi',timestamp:0,vocalTiming:{end:1,segments:[{text:speaker?'A: Hi':'Hi',utf16Start:0,utf16Length:speaker?5:2,start:0,end:1}]}}]},'test',speaker?{A:'Alice'}:{});
 const translations=acceptedTranslations(doc,['fr','es','zh-Hans','zh-Hant'].map(target=>({target,content:{lines:[{sourceID:'L0001',lyricText:'Hi',text:'Hi',speakerID:doc.structure.occurrences[0].speakerID,startsTurn:doc.structure.occurrences[0].startsTurn}],sourceNotes:[]}})));
 const {rows,...manifest}=inspectorManifest(doc,translations),tasks=studyTasks(doc,translations,manifest,allDirections);
 const studyArtifacts=tasks.map(task=>studyArtifact(doc,translations,task,{content:task.kind==='batch'?{items:task.selector.manifest.map(m=>({id:m.id,meaning:'hello',context:'greeting',uncertainty:'',sourceQuote:'Hi',grammar:''}))}:{meaning:'hello',context:'greeting',uncertainty:'',sourceQuote:'Hi',grammar:''}}));
 const spec={songID:song?.id??'cmn-1817103029',display:{title:'Test song',artist:'Independent artist',duration:10},documentVariant:variants[0],
  variants,uses:['read','play'],recordingEvidence:{documentID:doc.id,sourceHash:doc.sourceHash,variants,reference:'test-proof',reviewer:'test',timingVerified:true,listeningVerified:true},
  rights:{source:{provider:'qq',itemID:'1'},reference:'test-only-license',reviewer:'test',acquisition:true,derivatives:true,persistentServing:true,worldwide:true,territories:[],expiresAt:'2099-01-01T00:00:00.000Z'},parityReference:'test-only'};
 return {doc,translations,manifest,tasks,studyArtifacts,spec};
}
export function bundle(options){return assembleBundle(preparedInputs(options));}
