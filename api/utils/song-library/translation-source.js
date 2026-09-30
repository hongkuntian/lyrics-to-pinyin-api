// Correction history remains anchored to the immutable original source. A
// verified binding supplies song context when a reconstructed archive lacks it.
export async function translationSource(db,translationID) {
  const row=(await db.query(`SELECT d.*,a.response AS archived_response,a.structure AS archived_structure,a.source_hash AS archived_hash
    FROM song_translations t JOIN lyric_documents d ON d.id=t.document_id
    LEFT JOIN lyric_source_archives a ON a.document_id=d.id WHERE t.id=$1`,[translationID])).rows[0];
  if(!row)return null;
  if(!row.superseded_by)return {id:row.id,sourceHash:row.source_hash,response:row.response,structure:row.structure};
  if(!row.archived_response||row.archived_hash!==row.source_hash)return null;
  let response=row.archived_response;
  if(!response.song?.title?.original||!response.song?.artist?.original){
    const context=(await db.query(`SELECT d.response FROM translation_document_bindings b JOIN lyric_documents d ON d.id=b.document_id
      WHERE b.translation_id=$1 AND d.superseded_by IS NULL AND b.identity=$2 AND d.translation_identity=$2 ORDER BY b.created_at,b.document_id LIMIT 1`,[translationID,row.translation_identity])).rows[0];
    if(!context)return null;
    response={...response,song:{...context.response.song,...response.song}};
  }
  return {id:row.id,sourceHash:row.source_hash,response,structure:row.archived_structure};
}
