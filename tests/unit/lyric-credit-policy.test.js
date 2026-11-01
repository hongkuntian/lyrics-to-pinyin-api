import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import {creditLabelKey,isProductionRole,ambiguousProductionRoles} from '../../api/utils/lyric-credit-policy.js';

test('every declared credit alias and bilingual expansion executes through the shared policy',async()=>{
  const policy=JSON.parse(await readFile(new URL('../../api/data/lyric-credit-policy.json',import.meta.url),'utf8'));
  assert.equal(policy.version,1);
  for(const {chinese,english} of policy.roleGroups){
    const labels=[...chinese,...english,...chinese.flatMap(zh=>english.flatMap(en=>[
      zh+en,en+zh,zh+'('+en+')',en+'('+zh+')']))];
    for(const label of labels){
      const key=creditLabelKey(label);
      assert.equal(isProductionRole(key),!ambiguousProductionRoles.has(key),label);
    }
  }
});
