// Production handlers and durable store, with injected account-free providers.
import {EventEmitter} from 'node:events';
import {createMusicRomanizeService,SELECTION_REVISION} from '../api/music-romanize.js';
import {createSongLibraryService,lyricLoader} from '../api/song-library.js';
import {libraryDB} from '../tests/helpers/library-db.js';
const recording={catalog_id:'1835909383',storefront:'us',artist:'TOP登陆少年组合',title:'流星雨',album:'流星雨',duration:271.291};
const rows=[['编曲Arrangement：Example',0],['合：',5],['一起唱这首歌',6],['张极Jeremy：',10],['我说：别走',11],['张泽禹Zack/左航LEFT：再唱一遍',20],['一起唱这首歌',23]];
let release;const gate=new Promise(r=>release=r);
const provider=(name,timed)=>({name,searchSong:async()=>({...recording,id:2734065329}),getLyrics:async()=>{if(timed)await gate;return {lines:rows.map(([text,timestamp])=>({text,timestamp:timed?timestamp:null}))};}});
const rawHandler=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[provider('NeteaseAPI',false),provider('KugouAPI',true)],resolveCatalogAliasesFn:async()=>[],lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,logger:{info(){},error(){}}});
const {db,store}=await libraryDB();
try {
 const handler=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:lyricLoader(rawHandler)}),frames=[];
 const res=new EventEmitter();Object.assign(res,{statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},write(line){const frame=JSON.parse(line);frames.push(frame);if(frame.event==='readable')release();return true;},json(body){throw new Error(JSON.stringify(body));},end(){}});
 await handler({method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording,delivery:'progressive-v1'}},res);
 const raw=frames.find(f=>f.event==='readable').response,document=frames.at(-1).document;
 if(!document||raw.quality.synced||!document.response.quality.synced)throw new Error('plain-to-timed fixture unavailable');
 console.log(JSON.stringify({provenance:{generator:'scripts/generate-lyric-delivery-fixture.mjs',productionHandlers:['createMusicRomanizeService','createSongLibraryService','SongLibraryStore'],injectedProviders:true,networkCalls:false,paidGeneration:false},request:{id:recording.catalog_id,catalogID:recording.catalog_id,storefront:recording.storefront,artist:recording.artist,title:recording.title,album:recording.album,duration:recording.duration},raw,document},null,2));
}finally{release();await db.close();}
