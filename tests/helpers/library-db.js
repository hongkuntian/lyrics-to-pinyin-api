import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';

export async function libraryDB(path) {
  const db=new PGlite(path);
  await db.exec(await readFile(new URL('../../db/001-song-library.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../../db/003-correction-foundation.sql',import.meta.url),'utf8'));
  if(!(await db.query("SELECT to_regclass('correction_review_queue') AS table_name")).rows[0].table_name)
    await db.exec(await readFile(new URL('../../db/005-correction-batches.sql',import.meta.url),'utf8'));
  const store=new SongLibraryStore({query:(...args)=>db.query(...args),transaction:fn=>db.transaction(fn)});
  await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000});
  await store.createUser('reader-a','token-a');
  await store.createUser('reader-b','token-b');
  return {db,store};
}
export const source={id:'doc-one',recordingKey:'recording-one',requestKey:'request-one',sourceHash:'source-one',
  selectionRevision:'test-selection',response:{song:{title:{original:'Original test song'},artist:{original:'Test artist'},language:'zh'},
    quality:{synced:true,partial:false,instrumental:false},metadata:{source:'test'},
    lines:[{original:'把今天唱成一首歌',romanized:'bǎ jīn tiān chàng chéng yī shǒu gē',timestamp:0}]},
  structure:{speakers:[],occurrences:[{sourceID:'L0001',sourceText:'把今天唱成一首歌',lyricText:'把今天唱成一首歌',speakerID:null,startsTurn:false,sourcePrefix:''}]}};
