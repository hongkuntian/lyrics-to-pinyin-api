import {createPrivateKey,sign} from 'node:crypto';
import {connect} from 'node:http2';
import {LibraryError} from '../song-library/store.js';

const BUNDLES=new Set(['com.hongkuntian.musicromanization','com.hongkuntian.Lyra']);
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function providerToken({teamID,keyID,privateKey},now=Date.now()) {
  const key=createPrivateKey(privateKey.replace(/\\n/g,'\n'));
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error('invalid_apns_key');
  const unsigned=`${encode({alg:'ES256',kid:keyID})}.${encode({iss:teamID,iat:Math.floor(now/1000)})}`;
  return `${unsigned}.${sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
}

export function apnsConfiguration(env=process.env) {
  const config={teamID:env.LYRA_APNS_TEAM_ID,keyID:env.LYRA_APNS_KEY_ID,privateKey:env.LYRA_APNS_PRIVATE_KEY};
  if(config.teamID!=='9ESZX68J8U'||!/^[A-Z0-9]{10}$/.test(config.keyID??'')||!config.privateKey)
    throw new LibraryError('push_not_configured',503);
  return config;
}

// One bounded HTTP/2 request. Neither tokens nor payloads are logged or persisted.
export function sendAPNs({bundleID,environment,token,payload,priority,jwt},transport=connect) {
  if(!BUNDLES.has(bundleID))throw new LibraryError('app_access_revoked',403);
  return new Promise((resolve,reject)=>{
    const host=environment==='development'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
    const session=transport(host);let request,finished=false;
    const finish=(error,result)=>{
      if(finished)return;finished=true;clearTimeout(timeout);request?.close();session.close();session.destroy();
      if(error)reject(new LibraryError('push_unavailable',503));else resolve(result);
    };
    const timeout=setTimeout(()=>finish(new Error('timeout')),5000);
    session.on('error',finish);
    try {
      request=session.request({':method':'POST',':path':`/3/device/${token}`,
        authorization:`bearer ${jwt}`,'apns-topic':`${bundleID}.push-type.liveactivity`,'apns-push-type':'liveactivity',
        'apns-priority':String(priority),'apns-expiration':'0','content-type':'application/json'});
      let status,body='';
      request.on('response',headers=>{status=headers[':status'];});
      request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk;if(body.length>4096)finish(new Error('oversized_response'));});
      request.on('error',finish);
      request.on('end',()=>{
        let reason;try{reason=JSON.parse(body).reason;}catch{}
        finish(null,{status,reason});
      });
      request.end(JSON.stringify(payload));
    } catch(error){finish(error);}
  });
}

export function createAPNsSender({env=process.env,now=Date.now,send=sendAPNs}={}) {
  let cached;
  return async request=>{
    const config=apnsConfiguration(env),time=now();
    try {
      if(!cached||time-cached.at>45*60*1000)cached={at:time,token:providerToken(config,time)};
    } catch{throw new LibraryError('push_not_configured',503);}
    const result=await send({...request,jwt:cached.token});
    if(result.status===200)return;
    if(['BadDeviceToken','DeviceTokenNotForTopic','Unregistered'].includes(result.reason))throw new LibraryError('push_token_invalid',410);
    if(result.status===429)throw new LibraryError('push_rate_limited',429);
    if(result.status===403){cached=null;throw new LibraryError('push_credentials_rejected',503);}
    throw new LibraryError('push_unavailable',503);
  };
}
