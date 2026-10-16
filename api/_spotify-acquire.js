import {queue,callbackOptions} from './utils/spotify/queue.js';
import {createSpotifyRuntime} from './utils/spotify/runtime.js';
export const config={maxDuration:300};
export default queue.handleNodeCallback(async message=>{
 if(message?.version!==1||message.kind!=='acquire'||typeof message.connectionID!=='string'||typeof message.outboxID!=='string')throw new Error('invalid_queue_message');
 await createSpotifyRuntime().acquireMessage(message);
},callbackOptions);
