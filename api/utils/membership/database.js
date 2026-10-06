import pg from 'pg';
import {LibraryError} from '../song-library/store.js';
let shared;
export function accountDatabase(env=process.env) {
  if(!env.LYRA_ACCOUNT_DATABASE_URL)throw new LibraryError('public_access_unavailable',503);
  if(shared)return shared;
  const pool=new pg.Pool({connectionString:env.LYRA_ACCOUNT_DATABASE_URL,max:2,idleTimeoutMillis:10000,
    connectionTimeoutMillis:5000,statement_timeout:10000,allowExitOnIdle:true});
  pool.on('error',()=>{});
  shared={query:(...args)=>pool.query(...args),transaction:async fn=>{
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
  }};
  return shared;
}
