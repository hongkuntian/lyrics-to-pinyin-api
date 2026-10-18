import {AppAuthStore} from './utils/app-auth/store.js';
import {bearer,authError} from './utils/app-auth/http.js';
import {createListeningRuntime} from './utils/listening/runtime.js';
import {roomDTO,uuid,fail} from './utils/listening/model.js';
export const config={maxDuration:30};
const common=['version','action','sessionID','commandID','revision'];
const actions={list:['cursor'],create:['provider','title','name','shareName','storefront','connectionID','connectionEpoch'],join:['invite','name','shareName'],read:[],search:['term'],target:[],add:['trackID'],remove:['entryID'],reorder:['order'],start:['targetNonce','entryID'],sync:[],end:[],leave:[],profile:['name','shareName'],share:[],unshare:[],control:['control'],observe:['leaseID','sequence','entryID','trackID','positionMS','playing'],applied:['leaseID','entryID']};
export function validateSessionInput(body){
 if(!body||Array.isArray(body)||body.version!==1||!Object.hasOwn(actions,body.action)||Buffer.byteLength(JSON.stringify(body))>16384||Object.keys(body).some(k=>![...common,...actions[body.action]].includes(k)))fail('invalid_request',400);
 for(const key of ['sessionID','commandID','entryID','leaseID'])if(body[key]!==undefined){if(!uuid(body[key]))fail('invalid_request',400);body[key]=body[key].toLowerCase();}
 if(!['list','create','join'].includes(body.action)&&!uuid(body.sessionID))fail('invalid_request',400);
 if(body.revision!==undefined&&(!Number.isSafeInteger(body.revision)||body.revision<0))fail('invalid_request',400);
 for(const key of ['connectionID','connectionEpoch','targetNonce'])if(body[key]!==undefined&&(typeof body[key]!=='string'||body[key].length<1||body[key].length>128))fail('invalid_request',400);
 if(body.trackID!==undefined&&(typeof body.trackID!=='string'||!(/^[A-Za-z\d]{1,22}$/.test(body.trackID))))fail('invalid_request',400);
 if(body.order!==undefined&&(!Array.isArray(body.order)||body.order.length>100||body.order.some(id=>!uuid(id))))fail('invalid_request',400);
 if(body.order)body.order=body.order.map(id=>id.toLowerCase());
 if(body.cursor!==undefined&&(typeof body.cursor!=='string'||body.cursor.length>128))fail('invalid_request',400);
 if(body.control!==undefined&&!['play','pause','next'].includes(body.control))fail('invalid_request',400);
 return body;
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function page({title,description,content,link}){
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Lyrica</title><meta name="description" content="${escape(description)}"><style>body{font:17px system-ui;background:#f5f3ee;color:#242321;max-width:640px;margin:48px auto;padding:0 24px}h1{font-size:36px;line-height:1.1}p{line-height:1.6;color:#625e57}a{display:inline-block;padding:14px 22px;border-radius:30px;background:#34483c;color:white;text-decoration:none}li{padding:14px 0;border-bottom:1px solid #ddd}small{display:block;color:#777;margin-top:5px}footer{margin:48px 0;color:#777}</style><body><p>LYRICA · SHARED LISTENING</p><h1>${escape(title)}</h1><p>${escape(description)}</p>${content}<p><a href="${escape(link)}">Open in Lyrica</a></p><footer>Listen together. Keep the songs and the memories.<br>Made with Lyrica.</footer></body></html>`;
}
export function createSessionsHandler({authStore,runtime,runtimeFactory=createListeningRuntime,logger=console}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   if(req.method==='GET'){
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    if(req.query?.recap){
     const service=runtime??runtimeFactory(),room=await service.store.byShare(req.query.recap);if(!room||!await service.store.ownerAccountActive(room))fail('session_not_shared',404);
     const recap=roomDTO(room,null,{publicRecap:true});
     if(req.query.format==='json'){res.setHeader('Content-Type','application/json');return res.status(200).json({version:1,recap});}
     res.setHeader('Content-Type','text/html; charset=utf-8');
     return res.status(200).send(page({title:recap.title,description:`${recap.history.length} played songs · ${recap.provider==='spotify'?'Spotify':'Apple Music'}`,content:'<ol>'+recap.history.map(e=>`<li><a href="${e.track.provider==='spotify'?'https://open.spotify.com/track/':'https://music.apple.com/'+room.storefront+'/song/'}${encodeURIComponent(e.track.id)}">${escape(e.track.title)}</a><small>${escape(e.track.artist)} · Added by ${escape(e.contributorName)}</small></li>`).join('')+'</ol>',link:'lyrica://sessions/recap?token='+encodeURIComponent(req.query.recap)}));
    }
    const invite=req.query?.join;
    if(typeof invite!=='string'||!(/^[A-Za-z\d_-]{32}$/.test(invite)||/^\d{6}$/.test(invite)))fail('session_not_found',404);
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.status(200).send(page({title:'You’re invited to listen together',description:'One host plays. Everyone brings a song. Open Lyrica and join this private listening session.',content:'',link:'lyrica://sessions/join?invite='+encodeURIComponent(invite)}));
   }
   res.setHeader('Content-Type','application/json');
   if(req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
   const input=validateSessionInput(req.body),token=bearer(req);if(!token?.startsWith('lyra_s_'))fail('unauthorized',401);
   const service=runtime??runtimeFactory(),auth=authStore??new AppAuthStore(service.store.db),user=await auth.authenticate(token);await service.store.rateLimit(user.id,input.action);
   return res.status(200).json(await service.send(user,input));
  }catch(error){if(req.method==='GET'&&req.query?.format!=='json'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.status(error.status??503).send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lyrica</title><h1>This Lyrica link is unavailable</h1><p>Ask the host for a current invitation or recap link.</p>');}return authError(res,error,logger);}
 };
}
export default createSessionsHandler();
