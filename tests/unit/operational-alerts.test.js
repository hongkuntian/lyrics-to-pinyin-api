import test from 'node:test';
import assert from 'node:assert/strict';
import {alertEmail,emailConfiguration,sendAlertEmail} from '../../api/utils/song-library/operational-alerts.js';
const env={VERCEL_ENV:'production',LYRA_ALERT_EMAIL_ENABLED:'true',RESEND_API_KEY:'secret',LYRA_ALERT_FROM:'alerts@example.com',LYRA_ALERT_TO:'owner@example.com'};
test('email is production-only, explicitly enabled and addressed only by private configuration',()=>{
  assert.ok(emailConfiguration(env));
  for(const override of [{VERCEL_ENV:'preview'},{LYRA_ALERT_EMAIL_ENABLED:'false'},{RESEND_API_KEY:''},
    {LYRA_ALERT_TO:'owner@example.com\r\nBcc: stranger@example.com'},{LYRA_ALERT_FROM:'a@example.com,b@example.com'}])
    assert.equal(emailConfiguration({...env,...override}),null);
  const email=alertEmail(['global_budget','global_budget','<script>send secrets</script>'],emailConfiguration(env));
  assert.deepEqual(email.to,['owner@example.com']);assert.equal(email.text.match(/Paid work has reached/g).length,1);
  assert.ok(!JSON.stringify(email).includes('secret'));assert.ok(!JSON.stringify(email).includes('script'));
  assert.throws(()=>alertEmail(['invalid'],emailConfiguration(env)),/empty_alert_digest/);
});
test('Resend uses one fixed endpoint, timeout, stable idempotency and a frozen text payload',async()=>{
  let count=0;
  const result=await sendAlertEmail({id:'episode-id',key:'secret',payload:{text:'test'},fetchImpl:async(url,args)=>{
    count++;assert.equal(url,'https://api.resend.com/emails');assert.equal(args.headers['Idempotency-Key'],'lyra-incident/episode-id');
    assert.equal(args.body,'{"text":"test"}');assert.ok(args.signal);return {ok:true,json:async()=>({id:'mail-id'})};
  }});assert.deepEqual(result,{state:'accepted',id:'mail-id'});assert.equal(count,1);
});
test('email rejection and uncertain outcomes never trigger automatic network retries',async()=>{
  for(const [status,state] of [[401,'rejected'],[429,'rejected'],[500,'unknown']]) {
    let count=0;assert.deepEqual(await sendAlertEmail({id:'id',key:'key',payload:{},fetchImpl:async()=>{count++;return {ok:false,status};}}),{state});
    assert.equal(count,1);
  }
});
