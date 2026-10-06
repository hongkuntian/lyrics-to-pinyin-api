// Product identifiers are durable API data. Localized price/period copy comes from StoreKit.
export const PRODUCTS=Object.freeze({
  'com.hongkuntian.Lyra.plus.monthly':{tier:'plus',period:'month'},
  'com.hongkuntian.Lyra.plus.annual':{tier:'plus',period:'year'},
  'com.hongkuntian.Lyra.pro.monthly':{tier:'pro',period:'month'},
  'com.hongkuntian.Lyra.pro.annual':{tier:'pro',period:'year'}
});
export const STARTER=Object.freeze({translation:2,study:10});
export const PRO=Object.freeze({translation:20,study:80});
export const PREVIEW=Object.freeze({seconds:600,requests:200});
export const first=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]??null;

// Monthly anniversaries retain the original day, including Jan 31 -> Feb 28 -> Mar 31.
export function monthlyPeriod(anchor,now) {
  anchor=new Date(anchor);now=new Date(now);
  if(!Number.isFinite(+anchor)||!Number.isFinite(+now)||now<anchor)throw new RangeError('invalid_period');
  const boundary=offset=>{
    const year=anchor.getUTCFullYear(),month=anchor.getUTCMonth()+offset;
    const last=new Date(Date.UTC(year,month+1,0)).getUTCDate();
    return new Date(Date.UTC(year,month,Math.min(anchor.getUTCDate(),last),anchor.getUTCHours(),anchor.getUTCMinutes(),anchor.getUTCSeconds(),anchor.getUTCMilliseconds()));
  };
  let index=(now.getUTCFullYear()-anchor.getUTCFullYear())*12+now.getUTCMonth()-anchor.getUTCMonth();
  if(boundary(index)>now)index--;
  return {start:boundary(index),end:boundary(index+1)};
}

export function transactionFields(value,{bundleID,environment,now=new Date()}={}) {
  const product=PRODUCTS[value?.productId];
  if(!product||value.bundleId!==bundleID||value.environment!==environment||value.type!=='Auto-Renewable Subscription'||
     !/^[0-9]{1,40}$/.test(value.originalTransactionId??'')||!/^[0-9]{1,40}$/.test(value.transactionId??'')||
     !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.appAccountToken??'')||
     ![value.purchaseDate,value.expiresDate,value.signedDate].every(Number.isSafeInteger)||
     (value.originalPurchaseDate!==undefined&&(!Number.isSafeInteger(value.originalPurchaseDate)||value.originalPurchaseDate<0||value.originalPurchaseDate>value.purchaseDate))||
     value.purchaseDate<0||value.purchaseDate>=value.expiresDate||value.signedDate>+now+300000||
     value.inAppOwnershipType!=='PURCHASED')throw new Error('invalid_transaction');
  return {originalID:value.originalTransactionId,transactionID:value.transactionId,productID:value.productId,
    tier:product.tier,environment,appAccountToken:value.appAccountToken.toLowerCase(),
    starts:new Date(value.originalPurchaseDate??value.purchaseDate),expires:new Date(value.expiresDate),signedAt:new Date(value.signedDate),
    revoked:value.revocationDate!=null||value.isUpgraded===true};
}
