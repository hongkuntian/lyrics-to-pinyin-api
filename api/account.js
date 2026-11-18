import {accountDatabase} from './utils/membership/database.js';
import {LibraryError} from './utils/song-library/store.js';
import {AccountStore} from './utils/membership/accounts.js';
import {AppAuthStore} from './utils/app-auth/store.js';
import {authError,bearer} from './utils/app-auth/http.js';
import {validDeviceToken} from './utils/membership/device-check.js';

const base64=value=>typeof value==='string'&&value.length>0&&Buffer.from(value,'base64').toString('base64')===value;
const nonce=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
// Lyrica has no sign-in. Anonymous enrollment (challenge, guest) is attested
// and unauthenticated; delete removes the guest account behind the session.
export function createAccountHandler({store,authStore,logger=console}={}) {
  return async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','private, no-store');
    if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
    try {
      const body=req.body,fields={challenge:['purpose','bundleID','keyID'],
        guest:['bundleID','keyID','challenge','attestation','credential','deviceToken'],delete:[]};
      if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>40000||!Object.hasOwn(fields,body.action)||
        Object.keys(body).some(k=>!['action',...fields[body.action]].includes(k))||
        (body.action!=='delete'&&(typeof body.bundleID!=='string'||body.bundleID.length>128||
          typeof body.keyID!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(body.keyID)||!base64(body.keyID)))||
        (body.action==='challenge'&&body.purpose!=='guest')||
        (body.action==='guest'&&(!nonce(body.challenge)||!base64(body.attestation)||body.attestation.length>28000||
          !/^lyrica_g_[A-Za-z0-9_-]{43}$/.test(body.credential??'')||(body.deviceToken!==undefined&&!validDeviceToken(body.deviceToken)))))
        throw new LibraryError('invalid_request',400);
      const accounts=store??new AccountStore(accountDatabase(),{logger});
      let result;
      if(body.action==='challenge')result=await accounts.challenge(body,
        // Only Vercel's overwritten client-IP header is trusted in deployment.
        process.env.VERCEL?req.headers?.['x-vercel-forwarded-for']?.split(',')[0]:req.socket?.remoteAddress);
      else if(body.action==='guest')result=await accounts.guest(body);
      else {
        const token=bearer(req);if(!token?.startsWith('lyrica_s_'))throw new LibraryError('unauthorized',401);
        const auth=authStore??new AppAuthStore(accounts.db),user=await auth.authenticate(token);await auth.limit(user.id);
        // Keep the exact bearer private; the deletion DTO stays V1.
        result=await accounts.delete(user,await accounts.prepareWriterAuthentication(token));
      }
      return res.status(200).json({version:1,...result});
    }catch(error){return authError(res,error,logger);}
  };
}
export default createAccountHandler();
