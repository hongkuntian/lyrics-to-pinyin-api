import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {evaluateRecovery} from '../../scripts/benchmark-artist-alias-recovery.mjs';
import {recoveryCorpus} from '../helpers/artist-alias-recovery.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
test('recovery benchmark counts failures and wrong source IDs and retains complete measured timing in acceptance',async()=>{
  const corpus=recoveryCorpus(),positive=corpus.cases.find(c=>c.caseID==='hyphenated-given-name-order'),
    control=corpus.cases.find(c=>c.caseID==='exact-native-credit'),negative=corpus.cases.find(c=>c.caseID==='live-title');
  const report=await evaluateRecovery({roots:[['candidate',root]],cases:[positive,control,negative],runs:1,delayMS:0});
  assert.equal(report.aggregate.candidate.attempts,3);assert.equal(report.aggregate.candidate.positiveAccepted,2);
  assert.equal(report.aggregate.candidate.negativeRejected,1);assert.equal(report.aggregate.candidate.falseAccepts,0);
  assert.equal(report.acceptance.candidateCorrect,true);assert.equal(report.acceptance.twoSearchBound,true);
  const wrong={...control,expectID:'999'};
  const failure=await evaluateRecovery({roots:[['candidate',root]],cases:[wrong],runs:1,delayMS:0});
  assert.equal(failure.aggregate.candidate.positiveAccepted,0);assert.equal(failure.aggregate.candidate.falseAccepts,1);
  assert.equal(failure.acceptance.candidateCorrect,false);assert.equal(failure.acceptance.noFalseAccepts,false);
});
