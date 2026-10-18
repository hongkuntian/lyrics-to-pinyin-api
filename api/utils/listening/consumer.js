import {listeningQueue} from './queue.js';
import {createListeningRuntime} from './runtime.js';
import {uuid} from './model.js';
export function createListeningConsumer({client=listeningQueue,runtimeFactory=createListeningRuntime}={}){
 return client.handleNodeCallback(async message=>{
  if(!message||message.version!==1||Object.keys(message).some(k=>!['version','sessionID','ordinal','outboxID','dueAtMS'].includes(k))||!uuid(message.sessionID)||!Number.isSafeInteger(message.ordinal)||message.ordinal<0||message.outboxID!==message.sessionID+':'+message.ordinal||!Number.isSafeInteger(message.dueAtMS))throw new Error('invalid_queue_message');
  await runtimeFactory().tick(message);
 },{visibilityTimeoutSeconds:30,retry:(_error,metadata)=>({afterSeconds:Math.min(300,2**Math.min(7,metadata.deliveryCount))})});
}
