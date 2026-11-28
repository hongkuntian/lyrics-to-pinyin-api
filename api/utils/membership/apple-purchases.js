import {readFileSync} from 'node:fs';
import {SignedDataVerifier,Environment,VerificationStatus} from '@apple/app-store-server-library';
import {LibraryError} from '../song-library/store.js';
import {storeEnvironment,transactionFields} from './policy.js';

// Apple PKI DER roots, retained so no caller-provided certificate becomes trusted.
const roots=['AppleIncRootCertificate','AppleRootCA-G2','AppleRootCA-G3'].map(name=>
  readFileSync(new URL(`../../data/apple-pki/${name}.cer`,import.meta.url)));
export class ApplePurchaseVerifier {
  constructor({env=process.env,Verifier=SignedDataVerifier}={}) {
    this.bundleID=env.LYRICA_STORE_BUNDLE_ID;
    const appID=Number(env.LYRICA_STORE_APP_APPLE_ID);
    if(!this.bundleID||!Number.isSafeInteger(appID)||appID<=0)throw new LibraryError('purchases_unavailable',503);
    this.environment=storeEnvironment(env);
    this.verifier=new Verifier(roots,true,this.environment,this.bundleID,appID);
  }
  async verify(method,value) {
    if(typeof value!=='string'||value.length>32000||!value)throw new LibraryError('invalid_transaction',400);
    try{return await this.verifier[method](value);}
    catch(error) {
      if(error.status===VerificationStatus.RETRYABLE_VERIFICATION_FAILURE)
        throw new LibraryError('purchase_verification_unavailable',503);
      // Apple's verifier checks the signature and bundle before reporting an environment mismatch.
      if(method==='verifyAndDecodeTransaction'&&error.status===VerificationStatus.INVALID_ENVIRONMENT)
        throw new LibraryError('purchase_environment_mismatch',403);
      throw new LibraryError('invalid_transaction',403);
    }
  }
  async transaction(signed) {
    const value=await this.verify('verifyAndDecodeTransaction',signed);
    try{return transactionFields(value,{bundleID:this.bundleID,environment:this.environment});}
    catch{throw new LibraryError('invalid_transaction',403);}
  }
  async notification(signed) {
    const value=await this.verify('verifyAndDecodeNotification',signed);
    if(typeof value.notificationUUID!=='string'||value.notificationUUID.length>128)throw new LibraryError('invalid_transaction',403);
    if(value.notificationType==='TEST')return {id:value.notificationUUID,transaction:null};
    if(!value.data?.signedTransactionInfo)throw new LibraryError('invalid_transaction',403);
    try {
      const transaction=transactionFields(await this.verifier.verifyAndDecodeTransaction(value.data.signedTransactionInfo),{bundleID:this.bundleID,environment:this.environment});
      return {id:value.notificationUUID,transaction};
    }catch{throw new LibraryError('invalid_transaction',403);}
  }
}
