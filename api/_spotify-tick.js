import {queue,callbackOptions} from './utils/spotify/queue.js';
import {createSpotifyRuntime} from './utils/spotify/runtime.js';
export const config={maxDuration:15};
// No public route is emitted. Queue delivery is a deployment trigger, not a
// caller-supplied CloudEvent authentication scheme.
export default queue.handleNodeCallback(async message=>{
 if(message?.version!==1||!['tick','wake','cleanup'].includes(message.kind)||typeof message.connectionID!=='string'||typeof message.outboxID!=='string')throw new Error('invalid_queue_message');
 await createSpotifyRuntime().tick(message);
},callbackOptions);
