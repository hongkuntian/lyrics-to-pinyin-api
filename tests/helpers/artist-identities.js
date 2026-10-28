export const artistIDs=['3LefT7hR0PJgShJNQoPns5','6noxsCszBEEK04kCehugOp'];
export const claim=value=>({rank:'normal',mainsnak:{snaktype:'value',datavalue:{value}}});
export function identityFixture() {
 const entities={Q101:{id:'Q101',type:'item',lastrevid:101,labels:{en:{language:'en',value:'Zhang Yusheng'},zh:{language:'zh',value:'张雨生'}},
  aliases:{en:[{language:'en',value:'Tom Chang'}]},claims:{P1902:[claim(artistIDs[0])]}},
 Q102:{id:'Q102',type:'item',lastrevid:102,labels:{en:{language:'en',value:'A-Mei Chang'},zh:{language:'zh',value:'张惠妹'}},
  aliases:{en:[{language:'en',value:'aMEI'}]},claims:{P1902:[claim(artistIDs[1])]}}};
 const rows=artistIDs.map((id,i)=>({spotify:{type:'literal',value:id},entity:{type:'uri',value:`http://www.wikidata.org/entity/Q${101+i}`}}));
 const calls=[];
 const fetchFn=async(url,options)=>{
  options?.signal?.throwIfAborted();const u=new URL(url);calls.push(u);
  if(u.hostname==='query.wikidata.org')return new Response(JSON.stringify({results:{bindings:rows.filter(row=>u.searchParams.get('query').includes(JSON.stringify(row.spotify.value)))}}));
  if(u.hostname==='www.wikidata.org')return new Response(JSON.stringify({entities:Object.fromEntries(u.searchParams.get('ids').split('|').filter(id=>entities[id]).map(id=>[id,entities[id]]))}));
  throw new Error('Unexpected identity endpoint');
 };
 return {entities,rows,calls,fetchFn};
}
export function identityCatalog(recording,song,profiles) {
 const rows=[],entities={};
 recording.metadata.artist_ids.forEach((spotify,i)=>{
  const qid='Q'+(8001+i),p=profiles[song.artists[i].id];
  rows.push({spotify:{type:'literal',value:spotify},entity:{type:'uri',value:'http://www.wikidata.org/entity/'+qid}});
  entities[qid]={id:qid,type:'item',lastrevid:101+i,labels:{en:{value:recording.metadata.artists[i]},native:{value:p.name}},
   aliases:{native:p.alias.map(value=>({value}))},claims:{P1902:[claim(spotify)]}};
 });
 const calls=[];
 const fetchFn=async(url,options)=>{
  options?.signal?.throwIfAborted();const u=new URL(url);calls.push(u);
  if(u.hostname==='query.wikidata.org')return new Response(JSON.stringify({results:{bindings:rows.filter(r=>u.searchParams.get('query').includes(JSON.stringify(r.spotify.value)))}}));
  return new Response(JSON.stringify({entities:Object.fromEntries(u.searchParams.get('ids').split('|').filter(id=>entities[id]).map(id=>[id,entities[id]]))}));
 };
 return {rows,entities,calls,fetchFn};
}
