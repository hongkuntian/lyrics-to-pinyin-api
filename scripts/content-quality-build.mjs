// Reuse the established unpromoted-production-build evaluation route when the
// provider credential is Sensitive and cannot be exported by Vercel.
import fs from 'node:fs/promises';
import {run} from './evaluate-content-quality.mjs';
export async function evaluateContentInBuild(env=process.env) {
 if(env.LYRA_CONTENT_QUALITY_EVALUATE_ON_BUILD!=='1')return;
 if(env.VERCEL!=='1'||env.VERCEL_ENV!=='production')throw new Error('evaluation_requires_production_build');
 if(!/^[a-f0-9]{64}$/.test(env.LYRA_CONTENT_QUALITY_PLAN_HASH??''))throw new Error('reviewed_plan_hash_required');
 const directory='/tmp/lyra-content-quality-evaluation';
 const claim=await fs.open('/tmp/lyra-content-quality-evaluation.lock','wx').catch(e=>{if(e.code!=='EEXIST')throw e;});
 if(!claim)return;
 await claim.close();await fs.mkdir(directory,{recursive:true});
 await fs.copyFile(new URL('../evaluation/content-quality/private-plan.json',import.meta.url),directory+'/plan.json');
 const summary=await run({directory,approvedHash:env.LYRA_CONTENT_QUALITY_PLAN_HASH,apiKey:env.OPENAI_API_KEY});
 for(const record of [...summary.results.map(r=>r.id), 'summary']) {
  const value=await fs.readFile(directory+'/'+record+'.json','utf8');
  const data=Buffer.from(value).toString('base64'),count=Math.ceil(data.length/2000);
  for(let index=0;index<count;index++)console.log(JSON.stringify({event:'content_quality_chunk',record,index,count,data:data.slice(index*2000,(index+1)*2000)}));
 }
}
