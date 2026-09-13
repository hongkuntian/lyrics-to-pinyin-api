import pg from 'pg';
import {LibraryError} from './store.js';
let shared;
export function database(env=process.env) {
  if(!env.LYRA_LIBRARY_DATABASE_URL) throw new LibraryError('library_not_configured',503);
  if(shared) return shared;
  const pool=new pg.Pool({connectionString:env.LYRA_LIBRARY_DATABASE_URL,max:3,
    idleTimeoutMillis:10_000,connectionTimeoutMillis:5_000,statement_timeout:10_000,allowExitOnIdle:true});
  pool.on('error',()=>{}); // Requests surface failures without logging connection strings.
  shared={query:(...args)=>pool.query(...args),transaction:async fn=> {
    const client=await pool.connect();
    try { await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value; }
    catch(error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
    finally { client.release(); }
  },close:()=>pool.end()};
  return shared;
}
