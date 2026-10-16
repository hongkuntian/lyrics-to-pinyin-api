import {queue,callbackOptions} from './queue.js';
import {createSpotifyRuntime} from './runtime.js';
export function createConsumer(kind,{client=queue,runtimeFactory=createSpotifyRuntime}={}){
 return client.handleNodeCallback(async(message,metadata)=>{
  const keys=['version','kind','connectionID','connectionEpoch','outboxID','ordinal','dueAtMS'];
  if(!message||Object.keys(message).some(k=>!keys.includes(k))||message.version!==1||!(kind==='tick'?['tick','wake','cleanup']:['acquire']).includes(message.kind)||['connectionID','connectionEpoch','outboxID'].some(k=>typeof message[k]!=='string'||message[k].length>256)||!Number.isSafeInteger(message.ordinal)||!Number.isSafeInteger(message.dueAtMS))throw new Error('invalid_queue_message');
  const runtime=runtimeFactory();
  try{if(kind==='tick')await runtime.tick(message);else await runtime.acquireMessage(message);}
  catch(error){if(metadata.deliveryCount>=120&&message.kind!=='cleanup'){await runtime.exhaust(message);return;}throw error;}
 },callbackOptions);
}
