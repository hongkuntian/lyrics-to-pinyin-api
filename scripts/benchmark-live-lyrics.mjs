// Local synthetic comparison only: no credentials, network calls, or APNs delivery.
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {LiveLyricsPushRelay,validatePush} from '../api/utils/live-lyrics/relay.js';
import {pushBody} from '../tests/helpers/live-lyrics.js';

const {values}=parseArgs({options:{users:{type:'string',default:'1000'},samples:{type:'string',default:'200'},baseline:{type:'string',default:'f8a490efa4d7715c62afacc79e08b686e6383ea5'}}});
const users=Number(values.users),samples=Number(values.samples);
if(!Number.isInteger(users)||users<1||users>10000||!Number.isInteger(samples)||samples<1||samples>1000)throw Error('bounded_users_and_samples_required');
const storeURL=new URL('../api/utils/song-library/store.js',import.meta.url).href;
const oldSource=execFileSync('git',['show',`${values.baseline}:api/utils/live-lyrics/relay.js`],{encoding:'utf8'})
  .replace("from '../song-library/store.js'",`from '${storeURL}'`);
const {LiveLyricsPushRelay:PreviousRelay}=await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString('base64')}`);

async function run(Relay,indexed) {
  const db=new PGlite();let sqlStatements=0;
  try {
    for(const name of ['001-song-library.sql','022-live-lyrics-push.sql',...(indexed?['024-live-lyrics-cleanup.sql']:[])])
      await db.exec(await readFile(new URL(`../db/${name}`,import.meta.url),'utf8'));
    await db.query("INSERT INTO library_users(id) SELECT 'load-user-'||i FROM generate_series(1,$1::int) i",[users]);
    await db.query(`INSERT INTO live_lyrics_push_rate_windows(user_id,window_start,count)
      SELECT 'load-user-'||i,date_trunc('minute',now())-m*interval '1 minute',1
      FROM generate_series(1,$1::int) i CROSS JOIN generate_series(0,59) m`,[users]);
    await db.query('ANALYZE live_lyrics_push_rate_windows');
    const plan=await db.query(`EXPLAIN (FORMAT JSON) DELETE FROM live_lyrics_push_rate_windows
      WHERE window_start<now()-interval '1 day'`);
    const tracked={query:(...args)=>{sqlStatements++;return db.query(...args);},transaction:fn=>{
      sqlStatements+=2; // BEGIN/COMMIT are managed by PGlite's transaction wrapper.
      return db.transaction(tx=>fn({query:(...args)=>{sqlStatements++;return tx.query(...args);}}));
    }};
    const start=Date.now(),durations=[],cpuStart=process.cpuUsage();
    // Less than one synthetic minute: models a warm burst, not subscriber concurrency.
    for(let i=0;i<samples;i++) {
      const user=i%users+1,sequence=Math.floor(i/users)+1,time=start+sequence*1000;
      const input=pushBody(sequence,time);input.activityID=`load-activity-${user}`;
      const relay=new Relay(tracked,{send:async()=>{},now:()=>time});
      const before=performance.now();
      await relay.update(`load-user-${user}`,validatePush(input,time));
      durations.push(performance.now()-before);
    }
    const cpu=process.cpuUsage(cpuStart),sorted=durations.toSorted((a,b)=>a-b);
    return {samples,seededRateWindows:users*60,sqlStatements,sqlPerUpdate:sqlStatements/samples,
      meanMs:durations.reduce((a,b)=>a+b,0)/samples,p50Ms:sorted[Math.floor(samples*.5)],p95Ms:sorted[Math.min(samples-1,Math.floor(samples*.95))],
      processCpuMs:(cpu.user+cpu.system)/1000,cleanupPlan:plan.rows[0]['QUERY PLAN']};
  }finally{await db.close();}
}

console.log(JSON.stringify({kind:'local_synthetic_PGlite_no_APNs_no_auth',baselineCommit:values.baseline,users,
  baseline:await run(PreviousRelay,false),indexedOnly:await run(PreviousRelay,true),boundedCleanup:await run(LiveLyricsPushRelay,true),
  limitations:['Sequential local requests, not a production load or concurrency test.','APNs transport and App Attest authentication are excluded.','Process CPU includes database engine work and is not Vercel billed CPU.','Database capacity and server latency must be measured on deployed infrastructure before public rollout.']},null,2));
