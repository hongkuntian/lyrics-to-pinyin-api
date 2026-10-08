import {LibraryError} from './store.js';

export const GROUNDING_FORMAT='study_explanation_grounded_1';
const fields=['meaning','context','grammar','uncertainty'];
export const groundingInstructions=`The original wording is the authority for source meaning. A stored or accepted translation is a fallible aid, not evidence that its interpretation is correct. Check it against the entire original song before using it; do not rationalize a contradiction. For translated-text Study, explain what the selected translation says while distinguishing any unsupported choice from what the original establishes.
Never silently repair unusual source wording, copy a familiar refrain over a changed occurrence, or substitute remembered lyrics. If the selected fragment is unclear, say so in meaning and context, leave unsupported grammar empty, and explain the unresolved wording in uncertainty. Do not teach a guessed correction as the word the learner selected. Distinguish lexical meaning, a contextual inference, and an unresolved reading. Qualify an inference where it appears, not only in a separate uncertainty field.
Give only grammar that helps understand the actual selected wording. Do not assign a whole phrase's meaning to a component. Keep the explanation concise and readable; an empty grammar field is preferable to an unsupported lesson.
For each nonempty meaning, context and grammar field, supply at least one evidence entry with that field, an occurrence ID, its layer (original or translation), and the EXACT full containing row. Use sourceText for original rows and lyricText for translated rows. Meaning and grammar must each cite the selected occurrence in the studied layer. Context must cite original-song evidence. Evidence checks identity and grounding only; a real quotation does not prove the explanation is correct. Never invent a quote. At most twelve evidence entries; do not reproduce unrelated lyrics in the learner-facing fields.`;

export const evidenceSchema={type:'array',items:{type:'object',additionalProperties:false,
 properties:{field:{type:'string',enum:fields},sourceID:{type:'string'},layer:{type:'string',enum:['original','translation']},sourceQuote:{type:'string'}},
 required:['field','sourceID','layer','sourceQuote']}};

// This is an evidence-identity check, not a semantic or linguistic classifier.
export function validateStudyEvidence(evidence,content,doc,translation,selection) {
 const fail=()=>{throw new LibraryError('invalid_explanation_evidence',502);};
 if(!Array.isArray(evidence)||!evidence.length||evidence.length>12)fail();
 const seen=new Set(),studiedLayer=selection.studyText?.layer??'original';
 for(const e of evidence) {
  if(!e||Array.isArray(e)||Object.keys(e).sort().join()!=='field,layer,sourceID,sourceQuote'||
    !fields.includes(e.field)||!content[e.field]?.trim()||!['original','translation'].includes(e.layer))fail();
  const occurrence=doc.structure.occurrences.find(o=>o.sourceID===e.sourceID);
  const row=e.layer==='original'?occurrence?.sourceText:translation?.lines.find(l=>l.sourceID===e.sourceID)?.lyricText;
  if(!occurrence||typeof row!=='string'||e.sourceQuote!==row)fail();
  const key=JSON.stringify([e.field,e.layer,e.sourceID]);if(seen.has(key))fail();seen.add(key);
 }
 for(const field of ['meaning','context','grammar'].filter(f=>content[f]?.trim())) {
  if(!evidence.some(e=>e.field===field&&(field==='context'?e.layer==='original':e.sourceID===selection.sourceID&&e.layer===studiedLayer)))fail();
 }
}
