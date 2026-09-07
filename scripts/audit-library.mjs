// Opt-in live coverage audit; never run in the hermetic test gate.
// Usage: node scripts/audit-library.mjs playlists.json results.ndjson [endpoint]
// Input: [{name, tracks:[{artist,title,album,duration,catalog_id?,storefront?}]}].
// Output contains metadata and counts, never lyric text. Keep personal exports out of Git.
import fs from 'node:fs/promises';
const [input,output,endpoint='https://lyrics-to-pinyin-api.vercel.app/api/music-romanize']=process.argv.slice(2);
const lists=JSON.parse(await fs.readFile(input)); const songs=[...new Map(lists.flatMap(p=>p.tracks).map(t=>[JSON.stringify([t.title,t.artist,t.album,t.duration]),t])).values()];
let next=0,done=0;const results=[];await fs.writeFile(output,'');
await Promise.all(Array.from({length:2},async()=>{while(next<songs.length){const song=songs[next++];const start=Date.now();let result;try{const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({artist:song.artist,title:song.title,album:song.album,duration:song.duration,catalog_id:song.catalog_id,storefront:song.storefront}),signal:AbortSignal.timeout(24000)});const d=await r.json();result={...song,status:r.status,source:d.metadata?.source,matched:d.song,lines:d.lines?.length,timed:d.quality?.synced,error:d.code||d.error,ms:Date.now()-start};}catch(e){result={...song,status:0,error:e.message,ms:Date.now()-start};}results.push(result);await fs.appendFile(output,JSON.stringify(result)+'\n');done++;if(done%20===0||done===songs.length)console.log(`${done}/${songs.length}`,JSON.stringify(results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})));}}));
