import {POOL,hashID,exact,variantKey,fail,publicationGrant,descriptors,summary} from './core.js';
export const preparedActions={prepared_starters:['languages','variant','catalogStorefront'],prepared_lookup:['variant','use'],prepared_grant:['editionID','generation','use','variant'],prepared_artifact:['editionID','generation','use','variant','artifactID']};
export async function preparedRequest(input,{store,territory=null,now=Date.now()}={}){
 const action=input.action;
 if(!Object.hasOwn(preparedActions,action)||Object.keys(input).some(k=>k!=='action'&&!preparedActions[action].includes(k)))fail();
 if(input.variant!==undefined)variantKey(input.variant);
 if(action==='prepared_starters'){
  if(!Array.isArray(input.languages)||!input.languages.length||input.languages.length>6||new Set(input.languages).size!==input.languages.length||input.languages.some(l=>!Object.hasOwn(POOL,l))||input.catalogStorefront!==undefined&&!/^[a-z]{2}$/.test(input.catalogStorefront))fail();
  const rows=await store.all();
  const latest=new Map();for(const row of rows)for(const v of row.bundle.variants){const k=variantKey(v);if(!latest.has(k))latest.set(k,row);}
  const ready=[];
  for(const row of rows){
   try{publicationGrant(row,'read',territory,now);}catch{continue;}
   const variants=row.bundle.variants.filter(v=>latest.get(variantKey(v))===row&&(!input.variant||variantKey(v)===variantKey(input.variant))&&(!input.catalogStorefront||v.storefront===input.catalogStorefront));
   if((input.variant||input.catalogStorefront)&&!variants.length)continue;
   ready.push({...summary(row),variants});
  }
  return {preparedStarters:input.languages.map(language=>({language,songs:POOL[language].flatMap(song=>ready.filter(s=>s.songID===song.id))}))};
 }
 if(!['read','play'].includes(input.use))fail();
 if(action==='prepared_lookup'){
  if(!input.variant)fail();
  const row=await store.lookup(input.variant);
  if(!row)return {state:'unprepared'};
  const grant=publicationGrant(row,input.use,territory,now,input.variant);
  return {state:'ready',edition:summary(row),grant,artifacts:descriptors(row.bundle)};
 }
 if(!hashID(input.editionID)||typeof input.generation!=='string'||!/^[1-9]\d{0,18}$/.test(input.generation)||input.use==='play'&&!input.variant)fail();
 if(action==='prepared_artifact'&&!hashID(input.artifactID))fail();
 const row=await store.edition(input.editionID);
 if(!row)fail('prepared_unavailable',404);
 // Withdrawal takes precedence over a stale generation: callers must close the page.
 const grant=publicationGrant(row,input.use,territory,now,input.variant);
 if(String(row.generation)!==input.generation)fail('publication_changed',409);
 if(input.variant){const latest=await store.lookup(input.variant);if(!latest||latest.bundle.editionID!==row.bundle.editionID)fail('publication_changed',409);}
 if(action==='prepared_grant')return {state:'ready',grant,artifacts:descriptors(row.bundle)};
 const value=row.bundle.artifacts.find(a=>a.id===input.artifactID);
 if(!value)fail('artifact_unavailable',404);
 return {state:'ready',grant,artifact:value};
}
