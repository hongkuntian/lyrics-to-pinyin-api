// Observed catalog metadata; performed words in tests are synthetic.
export const recording={version:2,provider:'spotify',item_id:'0n7Ij8XEDfYYFRgBQjNjnf',metadata:{origin:'spotify',title:'愛你',artists:['Kimberley Chen'],artist_ids:['1dVbVQZjRGDjQmHD8oiS8k'],album:'Kimberley首張同名專輯',duration_ms:207840}};
export const mbID='20a80371-5185-4c7a-9c68-2afa264834b3',urlID='e6070c4a-9a7a-44bc-bcba-e84e42c6e88e';
export function discoveryFixture() {
 const resource='https://open.spotify.com/artist/'+recording.metadata.artist_ids[0];
 const reverse={id:urlID,resource,relations:[{type:'free streaming',direction:'backward','target-type':'artist',ended:false,artist:{id:mbID,name:'陳芳語'}}]};
 const artist={id:mbID,name:'陳芳語',aliases:[{name:'陈芳语',type:'Artist name'}],relations:[{type:'free streaming',ended:false,url:{id:urlID,resource}},{type:'wikidata',ended:false,url:{resource:'https://www.wikidata.org/wiki/Q6409821'}}]};
 const entity={id:'Q6409821',type:'item',lastrevid:2563176896,labels:{en:{value:'Kimberley Chen'},zh:{value:'陳芳語'}},aliases:{},claims:{P434:[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{value:mbID}}}]}};
 const calls=[];
 const fetchFn=async(url,options)=>{
  options.signal.throwIfAborted();const u=new URL(url);calls.push(u);
  if(u.hostname==='musicbrainz.org')return new Response(JSON.stringify(u.pathname.includes('/artist/')?artist:reverse));
  if(u.hostname==='www.wikidata.org')return new Response(JSON.stringify({entities:{Q6409821:entity}}));
  throw new Error('Unexpected discovery endpoint');
 };
 return {reverse,artist,entity,calls,fetchFn};
}
export const source={id:15712494,trackName:'愛你',artistName:'陳芳語',albumName:'Kimberley首張同名專輯',duration:208,syncedLyrics:'[00:06.88]一起听风唱歌\n[01:20.00]慢慢走向海边\n[03:09.85]今天依然陪着你'};
