import {makeDocument} from '../../api/utils/song-library/document.js';
import {languagePolicy} from '../../api/utils/song-library/languages.js';
import {acceptedTranslations,inspectorManifest,studyTasks,studyArtifact,assembleBundle} from '../../api/utils/prepared-editions/compiler.js';
export const allDirections=languagePolicy({translation:['*:en','*:fr','*:es','*:zh-Hans','*:zh-Hant'],explanation:['*:en','*:fr','*:es','*:zh-Hans','*:zh-Hant']});
export function preparedInputs(){
 const recording={catalog_id:'1817103029',storefront:'ca',title:'test',artist:'test',duration:10};
 const doc=makeDocument(recording,{song:{id:'1',duration:10,language:'en',title:{original:'test'},artist:{original:'test'}},quality:{synced:true,partial:false,instrumental:false},metadata:{source:'QQMusicAPI',lyric_timing:{version:1,provider:'appleMusic',recordingID:'1817103029',source:'qq:1:qrc',revision:'a'.repeat(64)}},lines:[{original:'Hi',romanized:'Hi',timestamp:0,vocalTiming:{end:1,segments:[{text:'Hi',utf16Start:0,utf16Length:2,start:0,end:1}]}}]},'test',{});
 const translations=acceptedTranslations(doc,['fr','es','zh-Hans','zh-Hant'].map(target=>({target,content:{lines:[{sourceID:'L0001',lyricText:'Hi',text:'Hi',speakerID:null,startsTurn:false}],sourceNotes:[]}})));
 const manifest=inspectorManifest(doc,translations),tasks=studyTasks(doc,translations,manifest,allDirections);
 const studyArtifacts=tasks.map(task=>studyArtifact(doc,translations,task,{content:task.kind==='batch'?{items:task.selector.manifest.map(m=>({id:m.id,meaning:'hello',context:'greeting',uncertainty:'',sourceQuote:'Hi',grammar:''}))}:{meaning:'hello',context:'greeting',uncertainty:'',sourceQuote:'Hi',grammar:''}}));
 const spec={songID:'cmn-1817103029',display:{title:'Test song',artist:'Independent artist',duration:10},documentVariant:{provider:'apple',catalogID:'1817103029',storefront:'ca'},
  variants:[{provider:'apple',catalogID:'1817103029',storefront:'ca'}],uses:['read','play'],recordingEvidence:{documentID:doc.id,sourceHash:doc.sourceHash,variants:[{provider:'apple',catalogID:'1817103029',storefront:'ca'}],reference:'test-proof',reviewer:'test',timingVerified:true,listeningVerified:true},
  rights:{source:{provider:'qq',itemID:'1'},reference:'test-only-license',reviewer:'test',acquisition:true,derivatives:true,persistentServing:true,worldwide:true,territories:[],expiresAt:'2099-01-01T00:00:00.000Z'},parityReference:'test-only'};
 return {doc,translations,manifest,tasks,studyArtifacts,spec};
}
export function bundle(){return assembleBundle(preparedInputs());}
