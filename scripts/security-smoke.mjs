// Live, read-only denial checks. No credentials or paid generation required.
import assert from 'node:assert/strict';
const base='https://lyrics-to-pinyin-api.vercel.app';
const results=[];
for(const path of ['/api/music-romanize','/api/romanize','/api/song-library','/api/app-auth']) {
  const headers={'Content-Type':'application/json'};
  const response=await fetch(base+path,{method:'POST',headers,body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});
  const body=await response.json();assert.equal(response.status,401,path);assert.equal(body.code,'unauthorized');
  assert.match(response.headers.get('cache-control'),/private.*no-store/);
  results.push({path,status:response.status,code:body.code});
}
for(const path of ['/api/music-romanize','/api/romanize','/api/song-library']) {
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer beta_fixture'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,401,path);assert.equal((await response.json()).code,'unauthorized');
}
const cron=await fetch(base+'/api/review-reports',{redirect:'error',signal:AbortSignal.timeout(15000)});
assert.equal(cron.status,401);results.push({path:'/api/review-reports',status:cron.status});
console.log(JSON.stringify({passed:true,checks:results}));
