import {timingSafeEqual} from 'node:crypto';
import {database} from './utils/song-library/database.js';
import {runReviewQueue} from './utils/song-library/review-queue.js';
import {BatchProvider} from './utils/song-library/batch-provider.js';
import {runOperationalAlerts} from './utils/song-library/operational-alerts.js';
export const config={maxDuration:300};
export function createReviewReportsHandler({env=process.env,db,run=runReviewQueue,alerts=runOperationalAlerts}={}) {
  return async(req,res)=> {
    res.setHeader('Cache-Control','private, no-store');
    if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({code:'method_not_allowed'});}
    if(env.VERCEL_ENV!=='production'||typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)return res.status(503).json({code:'schedule_not_configured'});
    const expected=Buffer.from(`Bearer ${env.CRON_SECRET}`),supplied=Buffer.from(typeof req.headers?.authorization==='string'?req.headers.authorization:'');
    if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return res.status(401).json({code:'unauthorized'});
    if(Object.keys(req.query??{}).length)return res.status(400).json({code:'invalid_request'});
    let store,result,workerError=false;
    try {
      store=db??database(env);
      if(!env.OPENAI_API_KEY){workerError=true;result={code:'review_not_configured'};}
      else result=await run({db:store,provider:new BatchProvider({apiKey:env.OPENAI_API_KEY})});
    } catch {workerError=true;result={code:'worker_unavailable'};}
    // Alerts are deterministic, work even without an OpenAI key, and never change
    // provider admission, review decisions, budgets or held reservations.
    try {if(store)await alerts({db:store,env,workerError});}
    catch {return res.status(503).json({code:'alerts_unavailable'});}
    return res.status(workerError?503:200).json(result);
  };
}
export default createReviewReportsHandler();
