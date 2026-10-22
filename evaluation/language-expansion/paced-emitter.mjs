// Research-only stdout adapter. Copy these exact bytes into Root's evaluation
// branch for BOTH zero-call qualification and later execution. No provider code.
import {setTimeout as delay} from 'node:timers/promises';
export const PACE_MS = 20;
export const RECORD_BYTES = 1900;
export function createPacedEmitter({
  write = line => new Promise((resolve, reject) => process.stdout.write(line, 'utf8', error => error ? reject(error) : resolve())),
  sleep = delay, maxStreamBytes = 16 * 1024 * 1024
} = {}) {
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < RECORD_BYTES || maxStreamBytes > 16 * 1024 * 1024) throw new Error('invalid_transport_stream_limit');
  let bytes = 0, active = false;
  return async value => {
    if (active) throw new Error('concurrent_emit');
    const json = JSON.stringify(value);
    if (!/^language_expansion_[a-z_]+$/.test(value.event ?? '') || Buffer.byteLength(json) > RECORD_BYTES) throw new Error('transport_record_limit');
    bytes += Buffer.byteLength(json) + 1;
    if (bytes > maxStreamBytes) throw new Error('transport_stream_limit');
    active = true;
    try {
      // Callback completion observes write errors/backpressure; delay is only in
      // this evaluation-only adapter, never the product or provider timeout.
      await write(json + '\n');
      await sleep(PACE_MS);
    } finally { active = false; }
  };
}
