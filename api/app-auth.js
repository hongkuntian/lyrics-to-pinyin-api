import {AppAuthStore} from './utils/app-auth/store.js';
import {bearer,authError} from './utils/app-auth/http.js';
import {database} from './utils/song-library/database.js';
import {LibraryError} from './utils/song-library/store.js';
export function createAppAuthHandler({store,logger=console}={}) {
  return async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
    try {
      const token=bearer(req);if(!token||token.startsWith('lyra_s_'))throw new LibraryError('unauthorized',401);
      const body=req.body,fields={challenge:['purpose'],register:['challenge','attestation'],session:['challenge','assertion']};
      if(!body||typeof body!=='object'||Array.isArray(body)||!Object.hasOwn(fields,body.action)||
        Object.keys(body).some(k=>!['action','keyID','bundleID',...fields[body.action]].includes(k))||Buffer.byteLength(JSON.stringify(body))>32768||
        typeof body.keyID!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(body.keyID)||typeof body.bundleID!=='string'||body.bundleID.length>128||
        (body.action!=='challenge'&&(typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge)))||
        (body.action==='register'&&(typeof body.attestation!=='string'||body.attestation.length>28000||!validBase64(body.attestation)))||
        (body.action==='session'&&(typeof body.assertion!=='string'||body.assertion.length>8192||!validBase64(body.assertion))))throw new LibraryError('invalid_request',400);
      const auth=store??new AppAuthStore(database());const result=await auth[body.action](token,body);
      return res.status(200).json({version:1,...result});
    }catch(error){return authError(res,error,logger);}
  };
}
const validBase64=value=>value.length>0&&Buffer.from(value,'base64').toString('base64')===value;
export default createAppAuthHandler();
