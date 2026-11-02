import {LibraryError} from '../song-library/store.js';

export async function assertRetainedAccountDeletionAvailable(db){
 const retained=(await db.query("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='listening_v2') AS present")).rows[0];
 if(!retained||retained.present!==false)throw new LibraryError('account_data_cleanup_required',503);
}

export async function scrubRetainedAccountData(db,userID){
 await assertRetainedAccountDeletionAvailable(db);
 const table=(await db.query("SELECT to_regclass('public.listening_rooms') AS name")).rows[0]?.name;
 if(!table)return;
 await db.query('DELETE FROM listening_rooms WHERE owner_id=$1',[userID]);
 await db.query(`UPDATE listening_rooms SET data=jsonb_set(data,'{members}',
  (SELECT jsonb_agg(CASE WHEN member->>'userID'=$1 THEN member || jsonb_build_object('userID',null,'name','Friend','shareName',false) ELSE member END)
   FROM jsonb_array_elements(data->'members') member)),updated_at=now()
  WHERE data @> $2::jsonb`,[userID,JSON.stringify({members:[{userID}]})]);
 await db.query('DELETE FROM listening_rate_windows WHERE user_id=$1',[userID]);
}
