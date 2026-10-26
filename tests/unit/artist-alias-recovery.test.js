import test from 'node:test';
import assert from 'node:assert/strict';
import {artistAliasRule,buildArtistAliasEvidence,recoveredArtistNames} from '../../api/utils/artist-alias-recovery.js';
import {recordingScore} from '../../api/utils/recording-match.js';

const request={recordingProvider:'spotify',recordingItemID:'0123456789ABCDEFGHIJKL',title:'Invented Song',
  artist:'Fei Yu-ching',creditedArtistNames:['Fei Yu-ching'],album:'Invented Album',duration:240};
const performers=[{id:27,name:'Independent Singer'}];
const source={id:42,source:'netease',title:request.title,artist:performers[0].name,
  creditedArtistNames:[performers[0].name],album:request.album,duration:240};
const profiles=new Map([['27',['Independent Singer','Yu-Ching Fei']]]);

test('artist-name recovery recognizes explicit comma order and hyphenated given-name order only',()=>{
  for(const [a,b,rule] of [['Fei Yu-ching','Yu-Ching Fei','hyphenated_name_order'],
    ['Ta-Yu Lo','Lo Ta-Yu','hyphenated_name_order'],['Lo Ta-Yu','Tayu Lo','hyphenated_name_order'],['Smith, Alice','Alice Smith','comma_name_order'],
    ['Alice Smith','Smith, Alice','comma_name_order'],['René Liu','Rene Liu','latin_diacritics'],['Ta-Yu Lo','Tayu Lo','exact']])
    assert.equal(artistAliasRule(a,b),rule);
  for(const [a,b] of [['Chou Jay','Jay Chou'],['Brian Adams','Bryan Adams'],['Julie Sue','Julie Su'],
    ['Yu-Ching Fei & Guest','Fei Yu-ching'],['The Who','Who The'],['陈奕迅','陳亦迅'],
    ['A B','B, A'],['Eason Chan','Eason Chаn']])assert.equal(artistAliasRule(a,b),null);
});

test('recovery evidence preserves source labels and is bound to the original recording and contributor set',()=>{
  const before=structuredClone(source),evidence=buildArtistAliasEvidence(source,performers,request,profiles);
  assert.ok(evidence);assert.deepEqual(source,before);
  const song={...source,artistAliasEvidence:evidence};
  assert.deepEqual(recoveredArtistNames(song,request),request.creditedArtistNames);
  assert.ok(recordingScore(song,request)>=0);
  assert.equal(recordingScore(source,request),-1);
  for(const changed of [{id:43},{source:'lrclib'},{album:'Changed'},{duration:241},{title:'Other Song'},
    {creditedArtistNames:['Different Singer']},{artist:'Different Singer'}])
    assert.equal(recordingScore({...song,...changed},request),-1);
  for(const changed of [{recordingItemID:'1123456789ABCDEFGHIJKL'},{duration:240.1},{album:'Changed'},
    {creditedArtistNames:['Fei Yu-ching','Guest']},{title:'Other Song'}])
    assert.equal(recordingScore(song,{...request,...changed}),-1);
  for(const change of [e=>({...e,policy:'old'}),e=>({...e,performers:e.performers.map(p=>({...p,id:'0'}))}),
    e=>({...e,performers:e.performers.map(p=>({...p,names:['Other Singer','Yu-Ching Fei']}))}),
    e=>({...e,performers:e.performers.map(p=>({...p,rule:'exact'}))})])
    assert.equal(recordingScore({...song,artistAliasEvidence:change(evidence)},request),-1);
});

test('automatic name recovery requires exact album, near-identical duration, fresh canonical profile and unambiguous credits',()=>{
  for(const [song,target,people,names] of [
    [{...source,album:'Other Album'},request,performers,profiles],
    [source,{...request,album:undefined},performers,profiles],
    [{...source,duration:240.501},request,performers,profiles],
    [{...source,title:'Invented Song (Live)'},request,performers,profiles],
    [{...source,isrc:'USABC2600001'},{...request,isrc:'USABC2600002'},performers,profiles],
    [source,request,[{...performers[0],id:0}],profiles],
    [source,request,performers,new Map([['27',['Unrelated Singer','Yu-Ching Fei']]])],
    [source,{...request,creditedArtistNames:['Fei Yu-ching','Guest']},performers,profiles],
    [{...source,creditedArtistNames:['Independent Singer','Second Singer']},
      {...request,creditedArtistNames:['Fei Yu-ching','Yu-Ching Fei']},
      [...performers,{id:28,name:'Second Singer'}],
      new Map([...profiles,['28',['Second Singer','Yu-Ching Fei']]])]
  ])assert.equal(buildArtistAliasEvidence(song,people,target,names),null);
});
