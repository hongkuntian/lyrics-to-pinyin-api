import {database} from './utils/song-library/database.js';
import {LibraryError} from './utils/song-library/store.js';
import {authError} from './utils/app-auth/http.js';
import {MembershipStore} from './utils/membership/store.js';
import {ApplePurchaseVerifier} from './utils/membership/apple-purchases.js';
export function createStoreNotificationHandler({store,verifier,logger=console}={}) {
  return async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({version:1,code:'method_not_allowed'});}
    try {
      if(!req.body||Object.keys(req.body).some(k=>k!=='signedPayload')||typeof req.body.signedPayload!=='string'||req.body.signedPayload.length>32000)
        throw new LibraryError('invalid_request',400);
      const event=await(verifier??new ApplePurchaseVerifier()).notification(req.body.signedPayload);
      if(event.transaction)await(store??new MembershipStore(database())).applyNotification(event.id,event.transaction);
      return res.status(200).json({version:1,received:true});
    }catch(error){return authError(res,error,logger);}
  };
}
export default createStoreNotificationHandler();
