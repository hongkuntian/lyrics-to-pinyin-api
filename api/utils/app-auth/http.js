import {AppAuthStore} from './store.js';
import {database} from '../song-library/database.js';
import {LibraryError,SongLibraryStore} from '../song-library/store.js';
export function bearer(req) {return req.headers?.authorization?.match(/^Bearer ([A-Za-z0-9_-]{6,256})$/)?.[1];}
export function authError(res,error,logger=console) {
  const known=error instanceof LibraryError,status=known?error.status:503;
  if(!known)logger.error?.('app_auth_unavailable');
  if(status===429)res.setHeader('Retry-After','60');
  return res.status(status).json({version:1,code:known?error.code:'app_auth_unavailable'});
}
export function withAppAuth(service,{authStore,libraryStore,route,logger=console}={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');
    if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
    try {
      const token=bearer(req);if(!token?.startsWith('lyra_s_'))throw new LibraryError('unauthorized',401);
      const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>(route==='library'?8192:32768))
        throw new LibraryError('invalid_request',400);
      const auth=authStore??new AppAuthStore(database()),user=await auth.authenticate(token);
      const library=libraryStore??new SongLibraryStore(auth.db);await library.rateLimit(user.id);
      if(body.options?.refresh===true||body.options?.refresh==='true'||body.refresh===true||body.refresh==='true')await auth.limit(user.id,true);
      req.lyraUser=user;return await service(req,res);
    }catch(error){return authError(res,error,logger);}
  };
}
