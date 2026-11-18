import {withAppAuth} from './utils/app-auth/http.js';
import {database} from './utils/song-library/database.js';
import {LibraryError} from './utils/song-library/store.js';
import {MembershipStore} from './utils/membership/store.js';
import {ApplePurchaseVerifier} from './utils/membership/apple-purchases.js';
export function createMembershipHandler({store,verifier,authStore,libraryStore,logger=console}={}) {
  return withAppAuth(async(req,res)=>{
    const fields={status:[],transaction:['signedTransaction','restore'],preview:['activityID','recordingID','deviceToken']},body=req.body;
    if(!Object.hasOwn(fields,body.action)||Object.keys(body).some(k=>!['action',...fields[body.action]].includes(k))||
      (body.restore!==undefined&&body.restore!=='true'))throw new LibraryError('invalid_request',400);
    const members=store??new MembershipStore(database(),{logger}),userID=req.lyricaUser.id;
    let result;
    if(body.action==='status')result=await members.snapshot(userID);
    else if(body.action==='preview')result=await members.claimPreview(userID,body,{bundleID:req.lyricaUser.bundleID});
    else result=await members.recordTransaction(userID,await(verifier??new ApplePurchaseVerifier()).transaction(body.signedTransaction),
      // Restore Purchases may move a purchase to this account; the automatic sync never does.
      {restore:body.restore==='true'});
    return res.status(200).json({version:1,...result});
  },{authStore,libraryStore,logger,route:'membership'});
}
export default createMembershipHandler();
