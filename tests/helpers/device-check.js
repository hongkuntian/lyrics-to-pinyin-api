import {generateKeyPairSync} from 'node:crypto';
import {DeviceCheckService} from '../../api/utils/membership/device-check.js';

// The real DeviceCheck client over a mocked Apple HTTP endpoint. No test
// reaches Apple; `respond` decides each answer from the recorded call.
const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'});
export const deviceCheckEnv=Object.freeze({LYRICA_APNS_TEAM_ID:'9ESZX68J8U',LYRICA_DEVICECHECK_KEY_ID:'ABCDE12345',LYRICA_DEVICECHECK_PRIVATE_KEY:key});
export const reply=(status,text='')=>({status,text:async()=>text});
export const bits=(bit0,bit1,lastUpdateTime)=>reply(200,JSON.stringify({bit0,bit1,last_update_time:lastUpdateTime}));
// Apple's actual text for a device with no stored bits (its documentation
// calls this "Bit State Not Found").
export const notFound=()=>reply(200,'Failed to find bit state');
export const deviceToken=Buffer.from('fixture-device-token').toString('base64');

export function mockDeviceCheck({configured=true,respond=()=>notFound(),now=Date.now,timeoutMs}={}) {
  const calls=[];
  const fetchFn=async(url,options)=>{
    const parsed=new URL(url),call={host:parsed.host,path:parsed.pathname,body:JSON.parse(options.body)};
    calls.push(call);return respond(call,options);
  };
  return {calls,device:new DeviceCheckService({env:configured?deviceCheckEnv:{},fetchFn,now,timeoutMs})};
}

// Captures structured log events so tests can prove what was (not) logged.
export function captureLogger() {
  const events=[];
  const record=level=>value=>events.push({level,value});
  return {events,logger:{info:record('info'),warn:record('warn'),error:record('error')}};
}

// A stateful stand-in for Apple's per-device two bits. An update sets the
// given bits and stamps last_update_time with the (injected) current month.
export function appleDeviceState(now=Date.now) {
  const devices=new Map();
  const month=()=>new Date(now()).toISOString().slice(0,7);
  return {devices,respond:({path,body})=>{
    const state=devices.get(body.device_token);
    if(path==='/v1/query_two_bits')return state?bits(state.bit0,state.bit1,state.lastUpdateTime):notFound();
    const next={bit0:state?.bit0??false,bit1:state?.bit1??false};
    if(body.bit0!==undefined)next.bit0=body.bit0;if(body.bit1!==undefined)next.bit1=body.bit1;
    devices.set(body.device_token,{...next,lastUpdateTime:month()});return reply(200);
  }};
}
