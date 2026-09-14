import test from 'node:test';
import assert from 'node:assert/strict';
import {source} from '../helpers/library-db.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';
import {parseAssessment} from '../../api/utils/song-library/review-assessment.js';
import {comparisonContext,verificationBody,parseVerification,comparisonDecision} from '../../api/utils/song-library/review-verification.js';
const content=parseTranslation(JSON.stringify({translations:{L0001:'Make a song of today.'},sourceNotes:[]}),source);
const a=parseAssessment(JSON.stringify({decision:'correct',summary:'Private proposer rationale.',changes:[{sourceID:'L0001',sourceQuote:source.structure.occurrences[0].sourceText,replacement:'Turn today into a song.',reason:'Private first-pass reason.'}]}),source,content);
const good={preferred:'A',sourceSufficient:true,noRegressions:true,materialImprovement:true,summary:'Source supports the change.',evidence:[{sourceID:'L0001',sourceQuote:source.structure.occurrences[0].sourceText,explanation:'The object is transformed into song.'}]};
test('fresh comparison is anonymous, source-complete and fixed to Luna for either ordering',()=> {
  for(const slot of ['A','B']) {
    const c=comparisonContext(source,content,a,slot),body=verificationBody(source,content,a,c),data=JSON.parse(body.input[0].content);
    assert.equal(body.model,'gpt-5.6-luna');assert.equal(body.tools,undefined);assert.equal(body.store,false);
    assert.deepEqual(data.sourceDocument.occurrences,source.structure.occurrences);
    assert.equal(data.variants[slot].L0001,a.candidate.translations.L0001);
    assert.equal(data.variants[slot==='A'?'B':'A'].L0001,content.lines[0].lyricText);
    assert.ok(!JSON.stringify(body).includes('Private'));assert.equal(data.reports,undefined);assert.equal(data.candidateSlot,undefined);
    assert.deepEqual(verificationBody(source,content,a,c),body);
  }
});
test('frozen comparison rejects changed candidate, baseline, source and ordering',()=> {
  const c=comparisonContext(source,content,a,'A');
  for(const change of [{...c,candidateHash:'bad'},{...c,candidateSlot:'B'},{...c,policyVersion:'other'}]) {
    // A different valid ordering can be frozen initially, but changing only the slot changes the body.
    if(change.candidateSlot==='B')assert.notDeepEqual(verificationBody(source,content,a,change),verificationBody(source,content,a,c));
    else assert.throws(()=>verificationBody(source,content,a,change));
  }
  assert.throws(()=>verificationBody(source,content,{...a,candidate:{...a.candidate,translations:{L0001:'Unreviewed.'}}},c));
  assert.throws(()=>verificationBody({...source,sourceHash:'changed'},content,a,c));
  assert.throws(()=>verificationBody(source,{...content,lines:[{...content.lines[0],lyricText:'Changed baseline.'}]},a,c));
});
test('comparison output rejects extra authority, malformed flags and unsupported source evidence',()=> {
  assert.deepEqual(parseVerification(JSON.stringify(good),source),good);
  for(const v of [{...good,publish:true},{...good,noRegressions:'true'},{...good,preferred:'candidate'},
    {...good,evidence:[...good.evidence,...good.evidence]}, {...good,evidence:[{...good.evidence[0],sourceQuote:'invented'}]},
    {...good,evidence:[{...good.evidence[0],sourceID:'L0002'}]}, {...good,evidence:[{...good.evidence[0],explanation:''}]}])
    assert.throws(()=>parseVerification(JSON.stringify(v),source));
  assert.throws(()=>parseVerification(JSON.stringify(good).replace('"preferred":"A"','"preferred":"A","preferred":"B"'),source),{code:'duplicate_json_fields'});
});
test('only a grounded material improvement without regression can pass publication policy',()=> {
  const c=comparisonContext(source,content,a,'A');
  assert.equal(comparisonDecision(good,a,c),'publish');
  for(const v of [{...good,preferred:'B'},{...good,preferred:'equivalent'},{...good,preferred:'uncertain'},
    {...good,sourceSufficient:false},{...good,noRegressions:false},{...good,materialImprovement:false},{...good,evidence:[]}])
    assert.notEqual(comparisonDecision(v,a,c),'publish');
});
