import {randomUUID} from 'node:crypto';
import {LibraryError,digest} from './store.js';
import {parseTranslation} from './translation.js';

const first=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0]??null;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const currentTranslationSQL=`SELECT r.id,r.recipe,r.content FROM song_translations t
  JOIN translation_heads h ON h.translation_id=t.id JOIN translation_revisions r ON r.id=h.revision_id
  WHERE t.document_id=$1 AND t.target=$2`;

// Trusted backend primitive only. No public handler dispatches to this function.
// The review publisher validates persisted assessment and comparison before calling it.
export async function publishRevision(database,args,{rollback=false}={}) {
  const {expectedRevisionID,sourceHash,publicationKey,actor,reason,candidate,restoreRevisionID}=args;
  if(!uuid(expectedRevisionID)||typeof sourceHash!=='string'||!sourceHash||
    typeof publicationKey!=='string'||!publicationKey.trim()||publicationKey.length>200||
    typeof actor!=='string'||!actor.trim()||actor.length>100||typeof reason!=='string'||!reason.trim()||reason.length>2000||
    (rollback&&!uuid(restoreRevisionID))) throw new LibraryError('invalid_publication',400);
  const hash=digest({expectedRevisionID,sourceHash,actor,reason,origin:rollback?'rollback':'correction',
    ...(rollback?{restoreRevisionID}:{candidate})});
  return database.transaction(async db=> {
    // Lock the stable translation container, not the changing revision UUID.
    const base=await first(db,`SELECT r.*,t.document_id,t.target FROM translation_revisions r
      JOIN song_translations t ON t.id=r.translation_id WHERE r.id=$1 FOR UPDATE OF t`,[expectedRevisionID]);
    if(!base) throw new LibraryError('translation_not_found',404);
    const prior=await first(db,'SELECT * FROM translation_revisions WHERE publication_key=$1',[publicationKey]);
    if(prior) {
      if(prior.request_hash!==hash) throw new LibraryError('publication_key_conflict');
      return {id:prior.id,recipe:prior.recipe,...prior.content};
    }
    const head=await first(db,'SELECT revision_id FROM translation_heads WHERE translation_id=$1',[base.translation_id]);
    if(head?.revision_id!==expectedRevisionID) throw new LibraryError('translation_revision_superseded');
    const row=await first(db,'SELECT * FROM lyric_documents WHERE id=$1',[base.document_id]);
    if(row.source_hash!==sourceHash||base.source_hash!==sourceHash) throw new LibraryError('source_changed');
    let content,recipe=base.recipe;
    if(rollback) {
      const restored=await first(db,'SELECT content,recipe FROM translation_revisions WHERE id=$1 AND translation_id=$2 AND source_hash=$3',
        [restoreRevisionID,base.translation_id,sourceHash]);
      if(!restored) throw new LibraryError('invalid_restore_revision',400);
      content=restored.content;recipe=restored.recipe;
    } else {
      content=parseTranslation(JSON.stringify(candidate),{structure:row.structure,response:row.response});
      if(content.rejectedNotes.length) throw new LibraryError('invalid_source_evidence',400);
      if(JSON.stringify(content)===JSON.stringify(base.content)) throw new LibraryError('translation_unchanged');
    }
    const id=randomUUID();
    await db.query(`INSERT INTO translation_revisions(id,translation_id,sequence,base_revision_id,source_hash,recipe,content,
      origin,publication_key,request_hash,actor,reason,restored_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id,base.translation_id,Number(base.sequence)+1,expectedRevisionID,sourceHash,recipe,JSON.stringify(content),
        rollback?'rollback':'correction',publicationKey,hash,actor,reason,rollback?restoreRevisionID:null]);
    const moved=await first(db,'UPDATE translation_heads SET revision_id=$1 WHERE translation_id=$2 AND revision_id=$3 RETURNING revision_id',
      [id,base.translation_id,expectedRevisionID]);
    if(!moved) throw new LibraryError('translation_revision_superseded');
    return {id,recipe,...content};
  });
}

export async function revisions(db,documentID,target) {
  return (await db.query(`SELECT r.id,r.sequence,r.base_revision_id,r.source_hash,r.recipe,r.origin,r.actor,r.reason,
    r.restored_from,r.created_at,(h.revision_id=r.id) AS current
    FROM translation_revisions r JOIN song_translations t ON t.id=r.translation_id
    JOIN translation_heads h ON h.translation_id=t.id WHERE t.document_id=$1 AND t.target=$2 ORDER BY r.sequence DESC LIMIT 100`,[documentID,target])).rows;
}
