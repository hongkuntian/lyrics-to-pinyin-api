import {deflateSync} from 'node:zlib';
const key=Buffer.from([64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]);
// Invented text only; the fixed XOR value is the public KRC format codec.
export const encodeKRC=raw=>Buffer.concat([Buffer.from('krc1'),Buffer.from(deflateSync(Buffer.from(raw)).map((b,i)=>b^key[i%16]))]).toString('base64');
