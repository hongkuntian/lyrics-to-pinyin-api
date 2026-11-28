import {timingSafeEqual} from 'node:crypto';
import {storeEnvironment} from './utils/membership/policy.js';
import {PreparedEditionStore} from './utils/prepared-editions/store.js';
import {preparedRequest} from './utils/prepared-editions/service.js';
import {sharedPreparedToken} from './utils/prepared-editions/shared.js';
import {database} from './utils/song-library/database.js';
import {LibraryError} from './utils/song-library/store.js';

export function createSharedPreparedHandler({env=process.env,store,logger=console}={}){
 return async (req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  const send=(status,body)=>res.status(status).json({version:1,...body});
  const token=env.LYRICA_SHARED_PREPARED_TOKEN;
  if(storeEnvironment(env)!=='Production'||!sharedPreparedToken(token))return send(404,{code:'not_found'});
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{code:'method_not_allowed'});}
  const header=req.headers?.authorization;
  const supplied=typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):null;
  if(!sharedPreparedToken(supplied)||!timingSafeEqual(Buffer.from(token),Buffer.from(supplied)))return send(401,{code:'unauthorized'});
  const input=req.body;
  if(!input||Array.isArray(input)||typeof input!=='object'||Buffer.byteLength(JSON.stringify(input))>8192)
   return send(400,{code:'invalid_request'});
  try{
   return send(200,await preparedRequest(input,{store:store??new PreparedEditionStore(database(env))}));
  }catch(error){
   if(error instanceof LibraryError)return send(error.status,{code:error.code});
   logger.error('shared_prepared_content_unavailable');
   return send(503,{code:'prepared_content_unavailable'});
  }
 };
}
export default createSharedPreparedHandler();
