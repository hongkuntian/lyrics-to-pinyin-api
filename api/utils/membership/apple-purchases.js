import {readFileSync} from 'node:fs';
import {SignedDataVerifier,Environment,VerificationStatus} from '@apple/app-store-server-library';
import {LibraryError} from '../song-library/store.js';
import {transactionFields} from './policy.js';

// Apple PKI DER roots, retained so no caller-provided certificate becomes trusted.
const roots=['AppleIncRootCertificate','AppleRootCA-G2','AppleRootCA-G3'].map(name=>
  readFileSync(new URL(`../../data/apple-pki/${name}.cer`,import.meta.url)));
export class ApplePurchaseVerifier {
  constructor({env=process.env,Verifier=SignedDataVerifier}={}) {
    this.bundleID=env.LYRA_STORE_BUNDLE_ID;
    const appID=Number(env.LYRA_STORE_APP_APPLE_ID);
    if(!this.bundleID||!Number.isSafeInteger(appID)||appID<=0)throw new LibraryError('purchases_unavailable',503);
    const environments=[Environment.PRODUCTION];
    if(env.LYRA_STORE_ALLOW_SANDBOX==='true')environments.push(Environment.SANDBOX);
    this.verifiers=environments.map(environment=>({environment,verifier:new Verifier(roots,true,environment,this.bundleID,appID)}));
  }
  async verify(method,value) {
    if(typeof value!=='string'||value.length>32000||!value)throw new LibraryError('invalid_transaction',400);
    let retryable=false;
    for(const entry of this.verifiers) {
      try{return {value:await entry.verifier[method](value),...entry};}
      catch(error){retryable||=error.status===VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;}
    }
    throw new LibraryError(retryable?'purchase_verification_unavailable':'invalid_transaction',retryable?503:403);
  }
  async transaction(signed) {
    const {value,environment}=await this.verify('verifyAndDecodeTransaction',signed);
    try{return transactionFields(value,{bundleID:this.bundleID,environment});}
    catch{throw new LibraryError('invalid_transaction',403);}
  }
  async notification(signed) {
    const {value,verifier,environment}=await this.verify('verifyAndDecodeNotification',signed);
    if(typeof value.notificationUUID!=='string'||value.notificationUUID.length>128)throw new LibraryError('invalid_transaction',403);
    if(value.notificationType==='TEST')return {id:value.notificationUUID,transaction:null};
    if(!value.data?.signedTransactionInfo)throw new LibraryError('invalid_transaction',403);
    try {
      const transaction=transactionFields(await verifier.verifyAndDecodeTransaction(value.data.signedTransactionInfo),{bundleID:this.bundleID,environment});
      return {id:value.notificationUUID,transaction};
    }catch{throw new LibraryError('invalid_transaction',403);}
  }
}
