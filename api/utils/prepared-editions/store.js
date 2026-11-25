import {validateBundle,variantKey,fail} from './core.js';
export class PreparedEditionStore{
 constructor(db){this.db=db;}
 // Summary lists never load protected corpus bodies or historical withdrawn bundles.
 async edition(id,{artifactID=null}={}){
  const projection=artifactID?`jsonb_build_object('artifacts',coalesce((SELECT jsonb_agg(a) FROM jsonb_array_elements(e.bundle->'artifacts') a WHERE a->>'id'=$2),'[]'::jsonb))`:
   `jsonb_build_object('artifacts',coalesce((SELECT jsonb_agg(a - 'content') FROM jsonb_array_elements(e.bundle->'artifacts') a),'[]'::jsonb))`;
  return (await this.db.query(`SELECT (e.bundle - 'artifacts') || ${projection} AS bundle,e.generation::text,e.state FROM prepared_editions e WHERE edition_id=$1`,artifactID?[id,artifactID]:[id])).rows[0]??null;
 }
 async lookup(variant){return (await this.db.query(`SELECT (e.bundle - 'artifacts') || jsonb_build_object('artifacts',coalesce((SELECT jsonb_agg(a - 'content') FROM jsonb_array_elements(e.bundle->'artifacts') a),'[]'::jsonb)) AS bundle,e.generation::text,e.state FROM prepared_edition_variants v JOIN prepared_editions e ON e.edition_id=v.edition_id WHERE v.variant_key=$1 ORDER BY e.generation DESC LIMIT 1`,[variantKey(variant)])).rows[0]??null;}
 async all(){return (await this.db.query("SELECT bundle - 'artifacts' AS bundle,generation::text,state FROM prepared_editions WHERE state='published' ORDER BY generation DESC")).rows;}
 // Serialized, compare-and-swap publication/withdrawal. Never expose through HTTP.
 async publish(bundle,{expectedGeneration=null,expectedHead=null}={}){
  validateBundle(bundle);
  if(Date.parse(bundle.rights.expiresAt)<=Date.now())fail('rights_expired',409);
  return this.db.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(71309,41)');
   const head=(await db.query('SELECT max(generation)::text AS generation FROM prepared_editions')).rows[0]?.generation??null;
   if(head!==expectedHead)fail('publication_changed',409);
   const current=(await db.query('SELECT generation::text FROM prepared_editions WHERE edition_id=$1 FOR UPDATE',[bundle.editionID])).rows[0];
   if((current?.generation??null)!==expectedGeneration)fail('publication_changed',409);
   // Source replacement withdraws every former edition sharing any exact mapping.
   for(const v of bundle.variants)await db.query(`UPDATE prepared_editions SET state='withdrawn',generation=nextval('prepared_publication_generation'),updated_at=now() WHERE edition_id<>$1 AND edition_id IN (SELECT edition_id FROM prepared_edition_variants WHERE variant_key=$2) AND state='published'`,[bundle.editionID,variantKey(v)]);
   const row=(await db.query(`INSERT INTO prepared_editions(edition_id,bundle,state) VALUES($1,$2,'published') ON CONFLICT(edition_id) DO UPDATE SET bundle=EXCLUDED.bundle,state='published',generation=nextval('prepared_publication_generation'),updated_at=now() RETURNING generation::text`,[bundle.editionID,JSON.stringify(bundle)])).rows[0];
   for(const v of bundle.variants)await db.query('INSERT INTO prepared_edition_variants(variant_key,edition_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[variantKey(v),bundle.editionID]);
   return {editionID:bundle.editionID,generation:row.generation,state:'published'};
  });
 }
 async withdraw(id,expectedGeneration){
  return this.db.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(71309,41)');
   const row=(await db.query(`UPDATE prepared_editions SET state='withdrawn',generation=nextval('prepared_publication_generation'),updated_at=now() WHERE edition_id=$1 AND generation=$2::bigint AND state='published' RETURNING generation::text`,[id,expectedGeneration])).rows[0];
   if(!row)fail('publication_changed',409);return {editionID:id,generation:row.generation,state:'withdrawn'};
  });
 }
}
