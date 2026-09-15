import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../../../shared/alert-catalog.json',import.meta.url),'utf8'));

export const ALERT_LIMITS=Object.freeze({daily:1,monthly:5});
const DASHBOARD='https://lyra-dashboard-roan.vercel.app';
const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
export function emailConfiguration(env) {
  const address=value=>typeof value==='string'&&value.length<=254&&/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value);
  if(env.VERCEL_ENV!=='production'||env.LYRA_ALERT_EMAIL_ENABLED!=='true'||
    typeof env.RESEND_API_KEY!=='string'||!env.RESEND_API_KEY.trim()||
    !address(env.LYRA_ALERT_FROM)||!address(env.LYRA_ALERT_TO))return null;
  return {key:env.RESEND_API_KEY,from:env.LYRA_ALERT_FROM,to:env.LYRA_ALERT_TO};
}
export function alertEmail(codes,config) {
  const messages=[...new Set(codes)].filter(code=>Object.hasOwn(catalog,code)).map(code=>catalog[code]);
  if(!messages.length)throw new Error('empty_alert_digest');
  return {from:config.from,to:[config.to],subject:'Lyra needs your attention',text:
    'Lyra found the following operational issues. Your spending limits have not changed.\n\n'+
    messages.map(m=>`${m.title}\n${m.detail}\n${DASHBOARD}${m.path}`).join('\n\n')+
    '\n\nThis digest is limited to once per UTC day and five times per UTC month. Unchanged incidents do not send again. Check the dashboard for current state.'};
}

// Claim and persist before the single network attempt. Even after process loss,
// the same incident is never sent again: Resend idempotency only lasts 24 hours,
// shorter than the gap between some daily cron invocations.
export async function runOperationalAlerts({db,env=process.env,send=sendAlertEmail,workerError}={}) {
  const config=emailConfiguration(env);
  const delivery=await db.transaction(async tx=> {
    await tx.query('SELECT id FROM library_alert_monitor WHERE id=1 FOR UPDATE');
    await tx.query(`UPDATE library_alert_monitor SET last_checked_at=now(),email_configured=$1,
      worker_error=coalesce($2,worker_error) WHERE id=1`,[!!config,workerError??null]);
    await tx.query("UPDATE library_alert_deliveries SET state='unknown',error_code='send_interrupted',completed_at=now() WHERE state='sending' AND attempted_at<now()-interval '10 minutes'");
    const codes=(await tx.query('SELECT code FROM library_alert_conditions ORDER BY code')).rows.map(r=>r.code);
    await tx.query('UPDATE library_alert_incidents SET resolved_at=now() WHERE resolved_at IS NULL AND NOT(code=ANY($1::text[]))',[codes]);
    for(const code of codes) {
      if(!Object.hasOwn(catalog,code))throw new Error('unknown_alert_condition');
      await tx.query(`INSERT INTO library_alert_incidents(id,code) VALUES($1,$2)
        ON CONFLICT(code) WHERE resolved_at IS NULL DO UPDATE SET last_seen_at=now()`,[randomUUID(),code]);
    }
    if(!config)return null;
    const count=await first(tx,`SELECT count(*) FILTER(WHERE attempted_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily,
      count(*) AS monthly FROM library_alert_deliveries WHERE attempted_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    if(Number(count.daily)>=ALERT_LIMITS.daily||Number(count.monthly)>=ALERT_LIMITS.monthly)return null;
    const incidents=(await tx.query('SELECT id,code FROM library_alert_incidents WHERE resolved_at IS NULL AND delivery_id IS NULL ORDER BY code')).rows;
    if(!incidents.length)return null;
    const id=randomUUID(),payload=alertEmail(incidents.map(i=>i.code),config);
    await tx.query("INSERT INTO library_alert_deliveries(id,state,payload) VALUES($1,'sending',$2)",[id,JSON.stringify(payload)]);
    await tx.query('UPDATE library_alert_incidents SET delivery_id=$1 WHERE id=ANY($2::uuid[])',[id,incidents.map(i=>i.id)]);
    return {id,payload};
  });
  if(!delivery)return {state:'quiet'};
  let result;
  try {result=await send({id:delivery.id,payload:delivery.payload,key:config.key});}
  catch {result={state:'unknown',errorCode:'send_outcome_unknown'};}
  if(!['accepted','rejected','unknown'].includes(result?.state)||
    result.state==='accepted'&&(typeof result.id!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(result.id)))
    result={state:'unknown',errorCode:'send_outcome_unknown'};
  await db.query(`UPDATE library_alert_deliveries SET state=$2,provider_id=$3,error_code=$4,completed_at=now() WHERE id=$1 AND state='sending'`,
    [delivery.id,result.state,result.state==='accepted'?result.id:null,result.state==='accepted'?null:result.state==='rejected'?'email_rejected':'send_outcome_unknown']);
  return {state:result.state};
}

export async function sendAlertEmail({id,payload,key,fetchImpl=fetch}) {
  const response=await fetchImpl('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(8000),
    headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`lyra-incident/${id}`},body:JSON.stringify(payload)});
  if(!response.ok)return {state:response.status>=400&&response.status<500?'rejected':'unknown'};
  const result=await response.json();
  return {state:'accepted',id:result?.id};
}
