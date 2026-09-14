import {timingSafeEqual} from 'node:crypto';
import {database} from './utils/song-library/database.js';
import {runReviewQueue} from './utils/song-library/review-queue.js';
import {BatchProvider} from './utils/song-library/batch-provider.js';
export const config={maxDuration:300};
export function createReviewReportsHandler({env=process.env,db,run=runReviewQueue}={}) {
  return async(req,res)=> {
    res.setHeader('Cache-Control','private, no-store');
    if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({code:'method_not_allowed'});}
    if(env.VERCEL_ENV!=='production'||typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)return res.status(503).json({code:'schedule_not_configured'});
    const expected=Buffer.from(`Bearer ${env.CRON_SECRET}`),supplied=Buffer.from(typeof req.headers?.authorization==='string'?req.headers.authorization:'');
    if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return res.status(401).json({code:'unauthorized'});
    if(Object.keys(req.query??{}).length)return res.status(400).json({code:'invalid_request'});
    if(!env.OPENAI_API_KEY)return res.status(503).json({code:'review_not_configured'});
    try {const result=await run({db:db??database(env),provider:new BatchProvider({apiKey:env.OPENAI_API_KEY})});
      return res.status(200).json(result);
    } catch {return res.status(503).json({code:'worker_unavailable'});}
  };
}
export default createReviewReportsHandler();
