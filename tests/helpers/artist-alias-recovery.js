import {setTimeout as delay} from 'node:timers/promises';

// Invented songs/words/IDs unless explicitly labelled captured metadata.
// Label variants and faults are evaluation inputs, never catalog authority.
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',
  title:'归途之歌',artists:['Lin Tsung-Hao'],album:'Invented Album',duration_ms:240000}};
const song={id:70042,name:recording.metadata.title,artists:[{id:70027,name:'Invented Performer'}],
  album:{name:recording.metadata.album},duration:240000};
const profiles={70027:{id:70027,name:'Invented Performer',alias:['Tsung-Hao Lin']}};
export const inventedLyrics={code:200,yrc:{lyric:'[12000,2000](12000,1000,0)一起(13000,1000,0)听\n[18000,2000](18000,1000,0)慢慢(19000,1000,0)唱'}};
const copy=value=>structuredClone(value);
const base=()=>({recording:copy(recording),songs:[copy(song)],profiles:copy(profiles),expectID:'70042',kind:'constructed_name_variant'});
export function recoveryCorpus() {
  const cases=[];
  const add=(caseID,role,change=()=>{},kind)=>{
    const row=base();row.caseID=caseID;row.role=role;if(role==='reject')row.expectID=null;
    change(row);if(kind)row.kind=kind;cases.push(row);
  };
  add('hyphenated-given-name-order','recover');
  add('joined-hyphenated-given-name','recover',r=>{r.profiles[70027].alias=['Tsunghao Lin'];});
  add('explicit-comma-order','recover',r=>{r.recording.metadata.artists=['Alice Smith'];r.profiles[70027].alias=['Smith, Alice'];});
  add('reversed-comma-request','recover',r=>{r.recording.metadata.artists=['Smith, Alice'];r.profiles[70027].alias=['Alice Smith'];});
  add('duet-complete-credits','recover',r=>{
    r.recording.metadata.artists.push('Second Singer');r.songs[0].artists.push({id:70028,name:'Second Singer'});
  });
  add('trio-complete-credits','recover',r=>{
    r.recording.metadata.artists.push('Second Singer','Third Singer');
    r.songs[0].artists.push({id:70028,name:'Second Singer'},{id:70029,name:'Third Singer'});
  });
  add('native-title-query-recovery','recover',r=>{
    r.hiddenOnCombinedQuery=true;r.profiles[70027].alias=['Lin Tsung-Hao'];
  },'constructed_discovery_fault');
  add('native-title-query-and-name-recovery','recover',r=>{r.hiddenOnCombinedQuery=true;},'constructed_discovery_fault');
  add('exact-native-credit','control',r=>{r.recording.metadata.artists=['Invented Performer'];});
  add('exact-provider-alias','control',r=>{r.profiles[70027].alias=['Lin Tsung-Hao'];});
  add('exact-alias-with-recovered-peer','control',r=>{
    r.profiles[70027].alias=['Lin Tsung-Hao'];
    r.songs.push({...copy(r.songs[0]),id:70043,artists:[{id:70028,name:'Second Performer'}]});
    r.profiles[70028]={id:70028,name:'Second Performer',alias:['Tsung-Hao Lin']};
  });
  add('accent-profile-alias','control',r=>{r.recording.metadata.artists=['Rene Liu'];r.profiles[70027].alias=['René Liu'];});
  add('reported-qian-li-zhi-wai','control',r=>{
    r.recording={version:2,provider:'spotify',item_id:'3Pjp7lBM20zYzTlRurI6B7',metadata:{origin:'spotify',title:'千里之外',
      artists:['Jay Chou','Fei Yu-ching'],album:'依然范特西',duration_ms:256372}};
    r.songs=[{id:185880,name:'千里之外',artists:[{id:6452,name:'周杰伦'},{id:2747,name:'费玉清'}],album:{name:'依然范特西'},duration:254373}];
    r.profiles={6452:{id:6452,name:'周杰伦',alias:['Jay Chou','周董']},2747:{id:2747,name:'费玉清',alias:['Yu-Ching Fei','张彦亭','小哥']}};
    r.expectID='185880';
  },'captured_metadata_with_invented_lyrics');
  // One changed fact at a time; each must remain rejected. Avoid publishing
  // a misleading global precision estimate from this constructed challenge set.
  const changes={
    'wrong-title':r=>{r.songs[0].name='归途别歌';},
    'title-typo':r=>{r.recording.metadata.title='归途之哥';},
    'wrong-album':r=>{r.songs[0].album.name='Other Album';},
    'missing-album':r=>{delete r.recording.metadata.album;},
    'duration-outside-recovery':r=>{r.songs[0].duration=240501;},
    'duration-wrong-recording':r=>{r.songs[0].duration=260000;},
    'live-title':r=>{r.songs[0].name+=' (Live)';},
    'live-album':r=>{r.songs[0].album.name+=' (Live)';},
    'remaster-title':r=>{r.songs[0].name+=' (Remastered)';},
    'remix-title':r=>{r.songs[0].name+=' (Remix)';},
    'acoustic-title':r=>{r.songs[0].name+=' (Acoustic)';},
    'instrumental-title':r=>{r.songs[0].name+=' (Instrumental)';},
    'isrc-conflict':r=>{r.songs[0].isrc='USABC2600001';r.recording.metadata.isrc='USABC2600002';},
    'explicit-conflict':r=>{r.songs[0].explicit=true;r.recording.metadata.explicit=false;},
    'missing-contributor':r=>{r.recording.metadata.artists.push('Guest');},
    'extra-contributor':r=>{r.songs[0].artists.push({id:70028,name:'Guest'});},
    'changed-profile-id':r=>{r.profiles[70027].id=999;},
    'changed-profile-name':r=>{r.profiles[70027].name='Different Performer';},
    'no-profile-alias':r=>{r.profiles[70027].alias=[];},
    'unverified-source-artist-id':r=>{r.songs[0].artists[0].id=0;},
    'latin-name-typo':r=>{r.recording.metadata.artists=['Lin Tsung-Hau'];},
    'plain-two-word-reorder':r=>{r.recording.metadata.artists=['Chou Jay'];r.profiles[70027].alias=['Jay Chou'];},
    'band-token-reorder':r=>{r.recording.metadata.artists=['Who The'];r.profiles[70027].alias=['The Who'];},
    'mixed-script-confusable':r=>{r.recording.metadata.artists=['Lin Tsung-Hаo'];},
    'duplicate-request-credit':r=>{r.recording.metadata.artists=['Lin Tsung-Hao','Lin Tsung-Hao'];r.songs[0].artists.push({id:70028,name:'Second Singer'});},
    'ambiguous-credit-assignment':r=>{
      r.recording.metadata.artists=['Lin Tsung-Hao','Tsung-Hao Lin'];r.songs[0].artists.push({id:70028,name:'Second Singer'});
      r.profiles[70028]={id:70028,name:'Second Singer',alias:['Tsung-Hao Lin']};
    },
    'conflicting-source-timelines':r=>{r.songs.push({...copy(r.songs[0]),id:70043});r.conflictingTimelines=true;},
    'oversized-unresolved-tie':r=>{r.songs.push(...Array.from({length:3},(_,i)=>({...copy(r.songs[0]),id:70043+i})));}
  };
  for(const [key,change] of Object.entries(changes))add(key,'reject',change,'constructed_negative');
  // Candidate order must not hide a conflicting timeline or a valid peer.
  for(const row of cases.filter(r=>r.songs.length>1))cases.push({...copy(row),caseID:row.caseID+'-reversed',songs:copy(row.songs).reverse()});
  add('unexamined-fourth-performer','reject',r=>{
    for(let i=1;i<=3;i++){
      const name='Other Performer '+i,id=70027+i;
      r.songs.push({...copy(r.songs[0]),id:70042+i,artists:[{id,name}]});
      r.profiles[id]={id,name,alias:[i===3?'Lin Tsung-Hao':'Unrelated Name']};
    }
  },'constructed_negative');
  return {version:1,kind:'controlled_artist_alias_recovery_challenge',cases,
    limitations:['All word content is invented. Most cases are constructed metadata representations or adversarial mutations.',
      'The reported duet control uses provider/catalog metadata observed on 2026-10-26; its lyric body remains synthetic.',
      'Measured delay is injected transport latency, not deployed or physical-device latency. This corpus does not estimate population precision or acoustic identity.']};
}
export function fixtureAPI(NeteaseAPI,row,{delayMS=0}={}) {
  const calls=[],api=new NeteaseAPI();
  const fetchFn=async(url,options={})=>{
    const u=new URL(url),path=u.pathname;calls.push({path,query:u.searchParams.get('keywords'),id:u.searchParams.get('id')??u.searchParams.get('ids')});
    options.signal?.throwIfAborted();if(delayMS)await delay(delayMS,undefined,{signal:options.signal});
    let body;
    if(path==='/search')body={code:200,result:{songs:row.hiddenOnCombinedQuery&&u.searchParams.get('keywords')!==row.recording.metadata.title?[]:row.songs}};
    else if(path==='/artist/detail')body={code:200,data:{artist:row.profiles[u.searchParams.get('id')]??null}};
    else if(path==='/song/detail')body={code:200,songs:row.songs.filter(s=>String(s.id)===u.searchParams.get('ids')).map(s=>({id:s.id,name:s.name,ar:s.artists,al:s.album,dt:s.duration,...(s.isrc?{isrc:s.isrc}:{}),...(typeof s.explicit==='boolean'?{explicit:s.explicit}:{})}))};
    else if(path==='/lyric/new'||path==='/lyric') {
      body=copy(inventedLyrics);
      if(row.conflictingTimelines&&u.searchParams.get('id')==='70043')body.yrc.lyric=body.yrc.lyric.replaceAll('12000','14000').replaceAll('13000','15000');
    }else throw new Error('Unexpected fixture request');
    return new Response(JSON.stringify(body));
  };
  for(const name of ['searchSong','getLyrics','getRecording']){const original=api[name].bind(api);api[name]=(...args)=>{
    const index=args.length-1;args[index]={...args[index],fetchFn};return original(...args);
  };}
  return {api,calls,fetchFn};
}
