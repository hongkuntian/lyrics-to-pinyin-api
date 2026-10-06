import {AppAuthStore} from './utils/app-auth/store.js';
import {bearer,authError} from './utils/app-auth/http.js';
import {database} from './utils/song-library/database.js';
import {LibraryError} from './utils/song-library/store.js';
import {createAPNsSender,apnsConfiguration} from './utils/live-lyrics/apns.js';
import {LiveLyricsPushRelay,validatePush} from './utils/live-lyrics/relay.js';

export const config={maxDuration:15};
export function createLiveLyricsHandler({authStore,relay,env=process.env,send=createAPNsSender({env}),now=Date.now,logger=console}={}) {
  return async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
    try {
      const token=bearer(req);if(!token?.startsWith('lyra_s_'))throw new LibraryError('unauthorized',401);
      if(!req.body||Buffer.byteLength(JSON.stringify(req.body))>8192)throw new LibraryError('invalid_request',400);
      const auth=authStore??new AppAuthStore(database()),user=await auth.authenticate(token);
      // The device cannot choose an APNs topic: use the identity proven during
      // App Attest enrollment and revalidated for this short-lived session.
      const input={...validatePush(req.body,now()),bundleID:user.bundleID};
      // An unconfigured experiment performs no push or receipt writes.
      if(!relay)apnsConfiguration(env);
      const result=await (relay??new LiveLyricsPushRelay(auth.db,{send,now})).update(user.id,input);
      return res.status(200).json({version:1,...result});
    } catch(error){
      if(error instanceof LibraryError && error.code==='push_rate_limited') {
        res.setHeader('Retry-After','1');return res.status(429).json({version:1,code:error.code});
      }
      return authError(res,error,logger);
    }
  };
}
export default createLiveLyricsHandler();
