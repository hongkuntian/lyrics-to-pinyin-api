import {randomUUID} from 'node:crypto';
import {providerToken} from '../live-lyrics/apns.js';

// Apple DeviceCheck two-bit state for one physical device.
//   bit 0: a Lyrica account was created on this device recently.
//   bit 1: this device has used the Live Lyrics preview.
// Device tokens and JWTs are never logged, persisted or put in an error.
const HOSTS=Object.freeze({production:'https://api.devicecheck.apple.com',development:'https://api.development.devicecheck.apple.com'});
const DEBUG_BUNDLE='com.hongkuntian.Lyrica.Debug';
// Apple accepts a provider JWT for up to an hour; refresh well before that.
const JWT_LIFETIME_MS=50*60*1000;

// "Unconfigured" (no DeviceCheck key) is a distinct state, checked with
// `configured`; every failure of a configured service is this error.
export class DeviceCheckError extends Error {
  constructor(reason){super('devicecheck_unavailable');this.name='DeviceCheckError';this.reason=reason;}
}

// The team ID is the one APNs already uses. Validation of the key itself
// happens when signing, so a malformed key is a configured-but-failing state.
export function deviceCheckConfiguration(env=process.env) {
  const config={teamID:env.LYRICA_APNS_TEAM_ID,keyID:env.LYRICA_DEVICECHECK_KEY_ID,privateKey:env.LYRICA_DEVICECHECK_PRIVATE_KEY};
  return config.teamID&&config.keyID&&config.privateKey?config:null;
}

export const validDeviceToken=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&
  Buffer.from(value,'base64').toString('base64')===value;

// last_update_time is "YYYY-MM" in UTC. Recent means this or the previous month.
export function recentlyUpdated(lastUpdateTime,now=Date.now()) {
  if(typeof lastUpdateTime!=='string'||!/^\d{4}-\d{2}$/.test(lastUpdateTime))return false;
  const date=new Date(now),month=(year,index)=>`${String(year).padStart(4,'0')}-${String(index+1).padStart(2,'0')}`;
  const year=date.getUTCFullYear(),index=date.getUTCMonth();
  return lastUpdateTime===month(year,index)||lastUpdateTime===(index===0?month(year-1,11):month(year,index-1));
}

// A device token Apple rejects on both hosts is not a valid token: callers
// treat it as a missing token, never as an outage, so a made-up token cannot
// skip the enrollment hold or the per-device preview limit.
export const rejectedDeviceToken=error=>error instanceof DeviceCheckError&&error.reason==='bad_device_token';

export class DeviceCheckService {
  #cached=null;
  constructor({env=process.env,fetchFn=globalThis.fetch,now=Date.now,timeoutMs=3000}={}) {
    this.env=env;this.fetch=fetchFn;this.now=now;this.timeoutMs=timeoutMs;
  }
  get configured(){return deviceCheckConfiguration(this.env)!==null;}
  #jwt() {
    const config=deviceCheckConfiguration(this.env);
    if(!config)throw new DeviceCheckError('unconfigured');
    const time=this.now();
    if(!this.#cached||this.#cached.keyID!==config.keyID||time-this.#cached.at>=JWT_LIFETIME_MS||time<this.#cached.at) {
      try{this.#cached={at:time,keyID:config.keyID,token:providerToken(config,time)};}
      catch{this.#cached=null;throw new DeviceCheckError('invalid_key');}
    }
    return this.#cached.token;
  }
  async #post(host,path,body) {
    let response,text;
    try {
      response=await this.fetch(HOSTS[host]+path,{method:'POST',
        headers:{authorization:`Bearer ${this.#jwt()}`,'content-type':'application/json'},
        body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});
      text=await response.text();
    }catch(error){
      if(error instanceof DeviceCheckError)throw error;
      throw new DeviceCheckError(error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network');
    }
    return {status:response.status,text:typeof text==='string'?text.slice(0,4096):''};
  }
  // The Debug bundle's tokens come from development-signed builds. A 400 for
  // the device token retries once on the other host; nothing else retries.
  async #request(path,token,{bundleID,...fields}) {
    if(!validDeviceToken(token))throw new DeviceCheckError('invalid_token');
    const hosts=bundleID===DEBUG_BUNDLE?['development','production']:['production','development'];
    const body={device_token:token,transaction_id:randomUUID(),timestamp:this.now(),...fields};
    let result=await this.#post(hosts[0],path,body);
    if(result.status===400&&/device.?token/i.test(result.text))
      result=await this.#post(hosts[1],path,{...body,transaction_id:randomUUID(),timestamp:this.now()});
    if(result.status===401||result.status===403)this.#cached=null;
    return result;
  }
  async query(token,{bundleID}={}) {
    const {status,text}=await this.#request('/v1/query_two_bits',token,{bundleID});
    if(status!==200)throw new DeviceCheckError(status===400&&/device.?token/i.test(text)?'bad_device_token':'status_'+status);
    // Apple documents this answer as "Bit State Not Found"; the service sends
    // "Failed to find bit state". Either means both bits are false.
    if(/^(?:bit state not found|failed to find bit state)\.?$/i.test(text.trim()))return {bit0:false,bit1:false,lastUpdateTime:null};
    let value;try{value=JSON.parse(text);}catch{throw new DeviceCheckError('malformed_response');}
    if(typeof value?.bit0!=='boolean'||typeof value.bit1!=='boolean'||
      (value.last_update_time!==undefined&&!/^\d{4}-\d{2}$/.test(value.last_update_time??'')))throw new DeviceCheckError('malformed_response');
    return {bit0:value.bit0,bit1:value.bit1,lastUpdateTime:value.last_update_time??null};
  }
  // Sets exactly one bit to true; Apple leaves an omitted bit unchanged.
  async setBit(token,{bundleID,bit}={}) {
    if(bit!==0&&bit!==1)throw new DeviceCheckError('invalid_bit');
    const {status,text}=await this.#request('/v1/update_two_bits',token,{bundleID,[`bit${bit}`]:true});
    if(status!==200)throw new DeviceCheckError(status===400&&/device.?token/i.test(text)?'bad_device_token':'status_'+status);
  }
}

// One client per process, so its provider JWT is reused across requests.
let shared;
export function defaultDeviceCheck(){return shared??=new DeviceCheckService();}
