import {readFileSync} from 'node:fs';
import {QQMusicAPI} from '../../api/music-apis/qq.js';
import {createArtistIdentityResolver} from '../../api/utils/artist-identities.js';
import {identityFixture,claim,artistIDs} from './artist-identities.js';

const qrc=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url)));
export function qqIdentityFixture() {
 const catalog=identityFixture(),entity=catalog.entities.Q101,singerMID='0025NhlN2yWrP4';
 entity.labels={en:{value:'English Test'},native:{value:'Test'}};entity.aliases={};entity.claims.P10410=[claim(singerMID)];
 const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Synthetic',artists:['English Test'],artist_ids:[artistIDs[0]],album:'Example',duration_ms:120000}};
 const detail={id:123,mid:'00000000000123',name:'Synthetic',title:'Synthetic',interval:120,album:{id:2,mid:'00000000000002',name:'Example'},singer:[{id:1,mid:singerMID,name:'Test'}]};
 const calls=[];let details=true,transform=value=>value;
 const fetchFn=async(url,init={})=>{
  calls.push(String(url));const payload=init.body?JSON.parse(init.body):null;let body;
  if(!payload)body=String(url).includes('smartbox_new.fcg')?{code:0,data:{song:{count:details?1:0,itemlist:details?[{id:'123',docid:'123',mid:detail.mid,name:detail.name,singer:'Test'}]:[]}}}
   :{code:0,data:{song:{list:[{songid:123,songmid:detail.mid,songname:detail.name,interval:detail.interval,albumid:2,albummid:detail.album.mid,albumname:detail.album.name,singer:detail.singer}]}}};
  else {
   body={code:0};for(const [key,entry] of Object.entries(payload))if(key!=='comm')body[key]=entry.method==='get_song_detail_yqq'
    ?{code:0,data:{track_info:transform(structuredClone(detail))}}
    :{code:0,data:{songID:123,songName:'Synthetic',singerName:'Test',qrc:entry.param.qrc,crypt:1,lyric:entry.param.qrc?qrc.providerQRC:qrc.providerLRC}};
  }
  return {ok:true,status:200,url:String(url),headers:new Map(),json:async()=>body};
 };
 const api=new QQMusicAPI(),search=api.searchSong.bind(api),getRecording=api.getRecording.bind(api),getLyrics=api.getLyrics.bind(api);
 api.searchSong=(artist,title,context)=>search(artist,title,{...context,fetchFn});
 api.getRecording=(songID,context)=>getRecording(songID,{...context,fetchFn});
 api.getLyrics=(songID,context)=>getLyrics(songID,{...context,fetchFn});
 const resolve=createArtistIdentityResolver({fetchFn:catalog.fetchFn});
 return {catalog,entity,recording,detail,api,calls,resolve,legacyOnly(){details=false;},transformDetail(value){transform=value;}};
}
