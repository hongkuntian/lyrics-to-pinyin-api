import {AppAuthStore} from './utils/app-auth/store.js';
import {bearer,authError} from './utils/app-auth/http.js';
import {LibraryError} from './utils/song-library/store.js';
import {createSpotifyRuntime} from './utils/spotify/runtime.js';
export const config={maxDuration:15};
const identity=['connectionID','connectionEpoch'];
const actions={
 'connection.enroll':['enrollmentID','refreshToken','scopeRawValue'],
 'connection.status':['enrollmentID'],'connection.access-token':identity,'connection.disconnect':[...identity,'enrollmentID'],
 'live.arm':[...identity,'armID','installationID','sessionID','activityID','activityGeneration','activityCreatedAtMS','token','tokenVersion','frequentPushesEnabled','recipe','recording'],
 'live.status':[...identity,'sessionID'],'live.token':[...identity,'sessionID','activityID','token','tokenVersion','frequentPushesEnabled'],
 'live.preferences':[...identity,'sessionID','recipe'],'live.hint':[...identity,'sessionID'],'live.stop':[...identity,'sessionID','reason'],
 'snapshot.read':[],'snapshot.token':['widgetToken','tokenVersion']};
const uuid=value=>typeof value==='string'&&/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/.test(value);
export function validateSpotifyInput(b,now=Date.now()){
 const bad=()=>{throw new LibraryError('invalid_request',400);};
 if(!b||Array.isArray(b)||b.version!==1||!Object.hasOwn(actions,b.action)||Buffer.byteLength(JSON.stringify(b))>16384||Object.keys(b).some(k=>!['version','action',...actions[b.action]].includes(k)))bad();
 let required=actions[b.action].filter(k=>b.action!=='live.token'||k!=='frequentPushesEnabled');if(b.action==='connection.disconnect'){if(b.enrollmentID!==undefined){if(b.connectionID!==undefined||b.connectionEpoch!==undefined)bad();required=['enrollmentID'];}else required=identity;}
 if(required.some(k=>!Object.hasOwn(b,k)))bad();
 for(const k of ['enrollmentID','armID','installationID','sessionID'])if(b[k]!==undefined&&!uuid(b[k]))bad();
 for(const k of identity)if(b[k]!==undefined&&(typeof b[k]!=='string'||b[k].length<1||b[k].length>128))bad();
 if(b.activityID!==undefined&&(typeof b.activityID!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(b.activityID)))bad();
 for(const k of ['token','widgetToken'])if(b[k]!==undefined&&(typeof b[k]!=='string'||!/^([a-f0-9]{2}){32,256}$/.test(b[k])))bad();
 if(b.tokenVersion!==undefined&&(!Number.isSafeInteger(b.tokenVersion)||b.tokenVersion<1||b.tokenVersion>2147483647))bad();
 if(b.action==='connection.enroll'&&(typeof b.refreshToken!=='string'||!b.refreshToken.length||b.refreshToken.length>4096||b.scopeRawValue!==49152))bad();
 if(b.frequentPushesEnabled!==undefined&&typeof b.frequentPushesEnabled!=='boolean')bad();
 if(b.action==='live.arm'&&(!Number.isSafeInteger(b.activityCreatedAtMS)||b.activityCreatedAtMS>now+2000||b.activityCreatedAtMS<=now-28500000))bad();
 if(b.action==='live.arm'&&(b.activityGeneration!==1||typeof b.frequentPushesEnabled!=='boolean'))bad();
 if(b.action==='live.stop'&&!['user','sourceChanged','dismissed'].includes(b.reason))bad();
 return b;
}
export function createSpotifyHandler({authStore,runtime,runtimeFactory=createSpotifyRuntime,logger=console}={}){
 return async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
  try{
   const input=validateSpotifyInput(req.body),token=bearer(req);
   if(!token?.startsWith(input.action.startsWith('snapshot.')?'lyra_w_':'lyra_s_'))throw new LibraryError('unauthorized',401);
   const service=runtime??runtimeFactory();let result;
   if(input.action.startsWith('snapshot.')){if(!token?.startsWith('lyra_w_'))throw new LibraryError('unauthorized',401);result=await service.snapshot(token,input);}
   else{
    if(!token?.startsWith('lyra_s_'))throw new LibraryError('unauthorized',401);
    const auth=authStore??new AppAuthStore(service.store.db),user=await auth.authenticate(token);await auth.limit?.(user.id);
    // Re-read attested environment rather than accepting client APNs selection.
    if(!user.environment){const key=(await auth.db.query('SELECT environment FROM app_attest_keys WHERE key_id=$1',[user.keyID])).rows[0];user.environment=key?.environment;}
    if(input.action==='connection.enroll'){await service.store?.maintenance?.(Date.now());result=await service.enrollment(user,input);}
    else if(input.action==='connection.status')result=await service.status(user,input);
    else if(input.action==='connection.access-token')result=await service.access(user,input);
    else if(input.action==='connection.disconnect')result=await service.disconnect(user,input);
    else if(input.action==='live.arm')result=await service.arm(user,input);
    else result=await service.live(user,input,input.action);
   }
   return res.status(200).json(result);
  }catch(error){return authError(res,error,logger);}
 };
}
export default createSpotifyHandler();
