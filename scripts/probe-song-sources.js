import {readFile} from 'node:fs/promises';
// Opt-in live source probe. Metadata/counts only; never logs lyrics or credentials.
// A supplied library token also exercises the durable route, without paid generation.
const corpus=JSON.parse(await readFile(new URL('../tests/fixtures/song-source-corpus.json',import.meta.url)));
const base=process.env.LYRA_PROBE_BASE??'https://lyrics-to-pinyin-api.vercel.app';
if(!/^https:\/\//u.test(base)&&!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/u.test(base)) throw new Error('invalid_probe_origin');
for(const recording of corpus.recordings) {
  for(const route of ['music-romanize',...(process.env.LYRA_LIBRARY_TOKEN?['song-library']:[])]) {
    const library=route==='song-library';
    const response=await fetch(new URL(`/api/${route}`,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:{'Content-Type':'application/json',...(library?{Authorization:`Bearer ${process.env.LYRA_LIBRARY_TOKEN}`}:{})},
      body:JSON.stringify(library?{action:'lyrics',recording,refresh:true}:{...recording,options:{refresh:true}})});
    const body=await response.json(),lyrics=library?body.document?.response:body;
    console.log(JSON.stringify({catalogID:recording.catalog_id,title:recording.title,route,status:response.status,code:body.code,
      source:lyrics?.metadata?.source,sourceID:lyrics?.song?.id,quality:lyrics?.quality,rows:lyrics?.lines?.length,
      credits:lyrics?.song_details?.credits?.length,providerTranslations:lyrics?.provider_translation?.lines?.length,
      revision:lyrics?.metadata?.selection_revision,documentID:body.document?.id}));
  }
}
