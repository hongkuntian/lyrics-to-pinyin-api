// Separate-process crash model using the production PostgreSQL store and a
// persisted, secret-free stand-in for the externally accepted queue log.
import fs from 'node:fs/promises';
import {fixture,user} from '../helpers/spotify.js';
const [directory,mode]=process.argv.slice(2),queuePath=directory+'/queue.json';
let queue=[];try{queue=JSON.parse(await fs.readFile(queuePath,'utf8'));}catch{}
const enqueue=async(kind,message,options)=>{if(!queue.some(row=>row.id===options.idempotencyKey)){queue.push({id:options.idempotencyKey,kind,message});await fs.writeFile(queuePath,JSON.stringify(queue));}return {messageId:options.idempotencyKey};};
const f=await fixture({after(){}},{path:directory+'/postgres',overrides:{enqueue}});
if(mode==='crash'){
 const {credential}=await f.enroll();await f.arm(credential);
 f.restart({crash:async point=>{if(point==='tickCommitted'){await f.db.exec('CHECKPOINT');process.exit(73);}}});
 await f.service.tick(queue[0].message);throw Error('expected crash');
}else{
 const c=(await f.db.query('SELECT data FROM spotify_connections')).rows[0].data;
 f.restart({provider:{refresh:async()=>{throw Error('duplicate refreshed');},playback:async()=>{throw Error('duplicate polled');}}});
 await f.service.tick(queue[0].message);
 const pending=await f.store.pending(c.id);
 console.log(JSON.stringify({ordinal:(await f.store.read(c.id)).tickOrdinal,pending:pending.length,queueKinds:queue.map(row=>row.kind),queueOrdinals:queue.filter(row=>row.kind==='tick').map(row=>row.message.ordinal)}));
 await f.db.close();
}
