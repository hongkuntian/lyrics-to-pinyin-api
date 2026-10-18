import {createMembershipHandler} from './membership.js';
import {createStoreNotificationHandler} from './store-notifications.js';
// Both canonical routes retain their existing authentication/signature checks.
export function createBillingGateway({membership=createMembershipHandler(),notifications=createStoreNotificationHandler()}={}){
 return (req,res)=>{
  if(req.query?._lyrica_endpoint==='membership')return membership(req,res);
  if(req.query?._lyrica_endpoint==='store-notifications')return notifications(req,res);
  res.setHeader('Cache-Control','private, no-store');return res.status(404).json({version:1,code:'not_found'});
 };
}
export default createBillingGateway();
