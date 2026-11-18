import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {digest} from '../../api/utils/song-library/store.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';

// Contract: an anonymous credential never expires while in use. Issuing an
// App Attest session slides it to 365 days, writing only under 300 days left.
const policy={audience:'test',environment:'production',prefix:'9ESZX68J8U',bundles:['com.test.Lyrica']},bundleID=policy.bundles[0];
const DAY=86400000;
async function fixture(t,{trace}={}){
  const f=await libraryDB();t.after(()=>f.db.close());
  await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
  await f.db.exec(await readFile(new URL('../../db/032-auth-token-row-locks.sql',import.meta.url),'utf8'));
  const raw=f.store.db,db=trace?{query:(sql,args)=>{trace.push({sql,args});return raw.query(sql,args);},
    transaction:fn=>raw.transaction(tx=>fn({query:(sql,args)=>{trace.push({sql,args,tx:true});return tx.query(sql,args);}}))}:raw;
  const accounts=new AccountStore(raw,{policy,deviceCheck:{configured:false},logger:{},attestFn:()=>({publicKey:'proof',receipt:Buffer.from('r')})});
  const auth=new AppAuthStore(db,{policy,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('r')}),assertionFn:({assertion})=>Number(assertion.toString())});
  let counter=0;
  const session=async(token,keyID)=>{
    const {challenge}=await auth.challenge(token,{keyID,bundleID,purpose:'session'});
    return auth.session(token,{keyID,bundleID,challenge,assertion:Buffer.from(String(++counter)).toString('base64')});
  };
  const expiry=async token=>(await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[digest(token)])).rows[0].expires_at;
  const clock=async()=>(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at;
  return {...f,accounts,auth,session,expiry,clock};
}
async function enroll(f,n=1){
  const keyID=Buffer.alloc(32,n).toString('base64'),credential='lyrica_g_'+String(n).repeat(43).slice(0,43);
  const nonce=await f.accounts.challenge({purpose:'guest',bundleID,keyID},'10.0.0.'+n);
  await f.accounts.guest({bundleID,keyID,...nonce,credential,attestation:'cHJvb2Y='});
  return {keyID,credential};
}
const within=(value,low,high)=>assert.ok(+value>=+low&&+value<=+high,`${new Date(value).toISOString()} outside expected window`);

test('a guest session slides its credential to 365 days and writes only when under 300 days remain',async t=>{
  const f=await fixture(t),g=await enroll(f);
  const issued=await f.expiry(g.credential);
  let before=await f.clock();await f.session(g.credential,g.keyID);let after=await f.clock();
  const slid=await f.expiry(g.credential);
  within(slid,+before+365*DAY,+after+365*DAY);assert.ok(+slid>+issued);
  // Over 300 days left: a second session writes nothing.
  await f.session(g.credential,g.keyID);
  assert.equal(+await f.expiry(g.credential),+slid);
  await f.db.query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '301 days' WHERE digest=$1",[digest(g.credential)]);
  const kept=await f.expiry(g.credential);await f.session(g.credential,g.keyID);
  assert.equal(+await f.expiry(g.credential),+kept);
  // Under 300 days left: slides again to a full year.
  await f.db.query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '299 days' WHERE digest=$1",[digest(g.credential)]);
  before=await f.clock();await f.session(g.credential,g.keyID);after=await f.clock();
  within(await f.expiry(g.credential),+before+365*DAY,+after+365*DAY);
});

test('challenges and key registration never slide; a second device slides the shared credential on its session',async t=>{
  const f=await fixture(t),g=await enroll(f);
  const issued=await f.expiry(g.credential),second=Buffer.alloc(32,9).toString('base64');
  const {challenge}=await f.auth.challenge(g.credential,{keyID:second,bundleID,purpose:'register'});
  await f.auth.register(g.credential,{keyID:second,bundleID,challenge,attestation:'cHJvb2Y='});
  assert.equal(+await f.expiry(g.credential),+issued);
  const before=await f.clock();await f.session(g.credential,second);
  within(await f.expiry(g.credential),+before+365*DAY,+(await f.clock())+365*DAY);
});

test('beta, unbounded, revoked, expired and disabled credentials never slide',async t=>{
  const f=await fixture(t);
  // Operator-issued beta credential: unbounded stays unbounded, finite stays put.
  const betaKey=Buffer.alloc(32,40).toString('base64');
  const {challenge}=await f.auth.challenge('token-a',{keyID:betaKey,bundleID,purpose:'register'});
  await f.auth.register('token-a',{keyID:betaKey,bundleID,challenge,attestation:'cHJvb2Y='});
  await f.session('token-a',betaKey);assert.equal(await f.expiry('token-a'),null);
  await f.db.query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '10 days' WHERE digest=$1",[digest('token-a')]);
  const finite=await f.expiry('token-a');await f.session('token-a',betaKey);
  assert.equal(+await f.expiry('token-a'),+finite);
  // The function itself refuses every other ineligible guest credential.
  const g=await enroll(f,2),slide=async()=>(await f.db.query('SELECT public.slide_guest_credential_expiry($1) AS at',[digest(g.credential)])).rows[0].at;
  for(const [label,change] of [['revoked',"UPDATE library_tokens SET revoked=true WHERE digest=$1"],
    ['expired',"UPDATE library_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE digest=$1"],
    ['unbounded',"UPDATE library_tokens SET expires_at=NULL WHERE digest=$1"],
    ['disabled',"UPDATE library_users SET disabled=true WHERE id=(SELECT user_id FROM library_tokens WHERE digest=$1)"]]){
    await f.db.query("UPDATE library_tokens SET revoked=false,expires_at=clock_timestamp()+interval '30 days' WHERE digest=$1",[digest(g.credential)]);
    await f.db.query("UPDATE library_users SET disabled=false WHERE id=(SELECT user_id FROM library_tokens WHERE digest=$1)",[digest(g.credential)]);
    await f.db.query(change,[digest(g.credential)]);
    const value=await f.expiry(g.credential);
    assert.equal(await slide(),null,label);assert.equal(+await f.expiry(g.credential),+value,label);
  }
  await f.db.query("UPDATE library_tokens SET revoked=false,expires_at=clock_timestamp()+interval '30 days' WHERE digest=$1",[digest(g.credential)]);
  await f.db.query("UPDATE library_users SET disabled=false WHERE id=(SELECT user_id FROM library_tokens WHERE digest=$1)",[digest(g.credential)]);
  assert.ok(await slide());assert.equal(await slide(),null,'a fresh slide leaves nothing to write');
});

test('session issuance slides inside its locked transaction after the token row lock',async t=>{
  const trace=[],f=await fixture(t,{trace}),g=await enroll(f);
  trace.length=0;await f.session(g.credential,g.keyID);
  const inTX=trace.filter(row=>row.tx).map(row=>row.sql);
  const tokenLock=inTX.findIndex(sql=>/FROM library_tokens WHERE digest=\$1 FOR UPDATE/.test(sql));
  const slide=inTX.findIndex(sql=>/slide_guest_credential_expiry/.test(sql));
  const insert=inTX.findIndex(sql=>/INSERT INTO app_auth_sessions/.test(sql));
  assert.ok(tokenLock>=0&&insert>tokenLock&&slide>insert,'slide after the token lock and session insert');
  assert.equal(inTX.slice(slide+1).some(sql=>/FOR (?:NO KEY )?UPDATE|FOR SHARE/.test(sql)),false,'no lock taken after the slide');
  assert.deepEqual(trace.filter(row=>/slide_guest_credential_expiry/.test(row.sql)).map(row=>row.args),[[digest(g.credential)]]);
});

test('the runtime login can change an expiry only through the bounded function',async t=>{
  const f=await fixture(t),g=await enroll(f);
  await f.db.query('CREATE ROLE lyrica_runtime_v1');await f.db.query('CREATE ROLE lyrica_account_v1');
  await replayMembershipRoleGrants(f.db);
  const privilege=async(role,kind)=>(await f.db.query(`SELECT has_function_privilege($1,'public.slide_guest_credential_expiry(text)',$2) AS ok`,[role,kind])).rows[0].ok;
  assert.equal(await privilege('lyrica_runtime_v1','EXECUTE'),true);
  assert.equal(await privilege('lyrica_account_v1','EXECUTE'),false);
  assert.equal((await f.db.query(`SELECT has_column_privilege('lyrica_runtime_v1','public.library_tokens','expires_at','UPDATE') AS ok`)).rows[0].ok,false);
  const definition=(await f.db.query(`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.slide_guest_credential_expiry(text)'::regprocedure`)).rows[0];
  assert.deepEqual(definition,{prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp']});
  await f.db.query("UPDATE library_tokens SET expires_at=clock_timestamp()+interval '1 day' WHERE digest=$1",[digest(g.credential)]);
  await f.db.query('SET ROLE lyrica_runtime_v1');
  try {
    await assert.rejects(f.db.query("UPDATE library_tokens SET expires_at=NULL WHERE digest=$1",[digest(g.credential)]),{code:'42501'});
    assert.ok((await f.db.query('SELECT public.slide_guest_credential_expiry($1) AS at',[digest(g.credential)])).rows[0].at);
  } finally {await f.db.query('RESET ROLE');}
  assert.ok(+await f.expiry(g.credential)>Date.now()+364*DAY);
});
