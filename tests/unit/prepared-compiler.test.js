import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedInputs,allDirections} from '../helpers/prepared-edition.js';
import {acceptedTranslations,inspectorManifest,translationTasks,studyTasks} from '../../api/utils/prepared-editions/compiler.js';
import {languagePolicy} from '../../api/utils/song-library/languages.js';
import {digest} from '../../api/utils/song-library/store.js';
test('five targets and 30 bounded layer/language contexts preserve repeated occurrence identity and native grapheme spans',()=>{
 const {doc,translations}=preparedInputs();
 const m=inspectorManifest(doc,translations);
 assert.equal(m.rows.length,6);assert.equal(m.requests.filter(r=>r.kind==='translation').length,5);
 const study=m.requests.filter(r=>r.kind!=='translation');
 assert.equal(study.filter(r=>r.kind==='batch').length,30);
 assert.equal(study.filter(r=>r.kind==='explanation').length,30);
 assert.ok(study.every(r=>!Object.hasOwn(r.selector,'contextTranslation')));
 assert.equal(new Set(study.map(r=>JSON.stringify(r))).size,study.length);
 const original=m.rows.find(r=>r.studyText.layer==='original');
 original.words[0].textHash=digest('wrong');assert.throws(()=>inspectorManifest(doc,translations,m.rows),/selection_changed/);
});
test('exact same-language original serves as translation; unsupported directions remain explicit gaps',()=>{
 const {doc}=preparedInputs();
 const tasks=translationTasks(doc,allDirections);assert.equal(tasks.length,4);assert.ok(tasks.every(t=>t.target!=='en'&&t.reservationMicros>0));
 assert.throws(()=>translationTasks(doc,languagePolicy()),/unsupported_direction/);
 assert.throws(()=>acceptedTranslations(doc,[]),/translation_incomplete/);
 const {translations,manifest}=preparedInputs();assert.equal(translations.en.identity,true);assert.equal(translations.en.lines[0].lyricText,'Hi');
 assert.throws(()=>studyTasks(doc,translations,manifest,languagePolicy()),/unsupported_direction/);
 assert.throws(()=>inspectorManifest(doc,translations,inspectorManifest(doc,translations).rows.slice(1)),/inspector_rows_incomplete/);
});
test('native request-only manifests honor hidden identity layers and require complete offered language contexts',()=>{
 const {doc,translations,manifest}=preparedInputs();
 const native={version:1,documentID:doc.id,sourceHash:doc.sourceHash,requests:manifest.requests.filter(q=>q.selector.studyText?.target!=='en')};
 assert.equal(inspectorManifest(doc,translations,native),native);
 assert.ok(studyTasks(doc,translations,native,allDirections).length>0);
 const broken={...native,requests:native.requests.filter((q,i)=>i!==native.requests.findIndex(q=>q.kind==='batch'))};
 assert.throws(()=>inspectorManifest(doc,translations,broken),/inspector_contexts_incomplete/);
 assert.throws(()=>inspectorManifest(doc,translations,{...native,requests:native.requests.filter(q=>q.kind==='translation')}),/inspector_contexts_incomplete/);
});
