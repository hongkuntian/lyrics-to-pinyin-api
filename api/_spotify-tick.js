import {createConsumer} from './utils/spotify/consumer.js';
export const config={maxDuration:15};
// Private deployment trigger only. No caller-supplied header grants access.
export default createConsumer('tick');
