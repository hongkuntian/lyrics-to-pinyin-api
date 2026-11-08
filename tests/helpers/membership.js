import {randomUUID,randomInt} from 'node:crypto';
// Records an active verified membership directly; purchase verification has its own tests.
export async function activateMembership(db,userID) {
  const id=String(randomInt(1e9,2**47));
  await db.query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
    app_account_token,period_start,expires_at,signed_at) VALUES($1,$2,$1,'com.hongkuntian.Lyra.pro.monthly','pro','Production',$3,
    now()-interval '1 day',now()+interval '30 days',now())`,[id,userID,randomUUID()]);
}
