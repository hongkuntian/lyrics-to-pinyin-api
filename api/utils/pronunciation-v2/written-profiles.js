import manifest from './written-data-manifest.json' with {type:'json'};
import {russianWrittenNotation,russianWrittenEngineVersion} from './russian-written.js';
import {hindiWrittenNotation,hindiWrittenEngineVersion} from './hindi-written.js';

// Deliberately separate from pronunciation-aids.js profiles. Legacy processor and
// romanize cache identity must not see these descriptors or their data revisions.
const rows=[
  ['ru-written','ru',russianWrittenNotation,russianWrittenEngineVersion],
  ['hi-deva-written','hi',hindiWrittenNotation,hindiWrittenEngineVersion]
];
export const writtenProfilesV2=Object.freeze(rows.map(([id,sourceLanguage,notation,engineVersion])=>{
  const data=manifest.profiles.find(row=>row.profileID===id);
  if(!data||data.engineVersion!==engineVersion)throw new Error('Written pronunciation manifest/profile mismatch');
  return Object.freeze({id,version:'1',sourceLanguage,kind:'romanization',notation:notation.id,
    outputScript:'Latn',readerLanguage:null,label:notation.label,engineVersion,
    status:'beta',basis:'text',limitations:notation.limitations,
    canonicalReadingKind:'none',readingScript:null,speechSemanticsVersion:'original-native-1',
    dataRevision:data.dataRevision});
}));

export function writtenProfileV2For(id){
  const profile=writtenProfilesV2.find(profile=>profile.id===id);
  if(!profile)throw new TypeError('Unsupported written pronunciation v2 profile');
  return profile;
}
