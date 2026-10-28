import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtistIdentityResolver} from '../../api/utils/artist-identities.js';
import {buildArtistIdentityEvidence,recoveredArtistNames,recoverySearchTitle} from '../../api/utils/artist-alias-recovery.js';
import {recordingScore} from '../../api/utils/recording-match.js';
import {spotifySearchRequest} from '../../api/utils/song-library/spotify-recording.js';
import {identityCatalog,claim} from '../helpers/artist-identities.js';

// Invented people and words exercise script-independent identity matching;
// these are not live catalog or acoustic equivalence claims.
const cases=[
 ['Japanese','Haruka Aoba','青葉春香','Aoba Haruka','ひかり'],
 ['Korean','Haneul Kim','김하늘','Kim Ha Neul','별빛'],
 ['Arabic','Nour Haddad','نور حداد','Nour El Haddad','نور'],
 ['Cyrillic','Mira Orlova','Мира Орлова','Mira Sergeyevna Orlova','Свет'],
 ['Devanagari','Anaya Rao','अनाया राव','Anaya Prakash Rao','रोशनी'],
];
async function fixture(row=cases[0]) {
 const [language,requested,native,alias,title]=row;
 const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title,artists:[requested],artist_ids:['1123456789ABCDEFGHIJKL'],album:'Invented album',duration_ms:240000}};
 const raw={id:42,name:title,artists:[{id:27,name:native}],album:{name:'Invented album'},duration:240000};
 const profiles={27:{id:27,name:native,alias:[alias]}},catalog=identityCatalog(recording,raw,profiles);
 const identities=await createArtistIdentityResolver({fetchFn:catalog.fetchFn})(recording.metadata.artist_ids);
 const song={id:42,source:'netease',title,artist:native,creditedArtistNames:[native],creditedArtistIDs:['27'],album:'Invented album',duration:240};
 return {language,recording,raw,catalog,identities,song,target:spotifySearchRequest(recording),performers:raw.artists,profiles:new Map([['27',[native,alias]]])};
}
for(const row of cases)test(`${row[0]} aliases recover only through the exact catalog artist identity`,async()=>{
 const f=await fixture(row),before=structuredClone(f.song),proof=buildArtistIdentityEvidence(f.song,f.performers,f.target,f.profiles,f.identities);
 assert.ok(proof);assert.deepEqual(f.song,before);const admitted={...f.song,artistAliasEvidence:proof};
 assert.deepEqual(recoveredArtistNames(admitted,f.target),f.recording.metadata.artists);assert.ok(recordingScore(admitted,f.target)>=0);
 assert.equal(recoverySearchTitle(f.target),f.song.title,'ID-bearing discovery is not restricted to Han titles');
 for(const changed of [{creditedArtistIDs:['2123456789ABCDEFGHIJKL']},{creditedArtistNames:['Another Artist']},
  {recordingItemID:'2123456789ABCDEFGHIJKL'},{creditedArtistIDs:undefined}])assert.equal(recordingScore(admitted,{...f.target,...changed}),-1);
});
test('homonyms, a changed fresh canonical profile and contradictory provider IDs gain no alias authority',async()=>{
 const f=await fixture();
 assert.equal(buildArtistIdentityEvidence(f.song,f.performers,f.target,new Map([['27',[f.song.artist]]]),f.identities),null);
 assert.equal(buildArtistIdentityEvidence(f.song,f.performers,f.target,new Map([['27',['Another Person','Aoba Haruka']]]),f.identities),null);
 f.catalog.entities.Q8001.claims.P10445=[claim('99')];
 const contradictory=await createArtistIdentityResolver({fetchFn:f.catalog.fetchFn})(f.recording.metadata.artist_ids);
 assert.equal(buildArtistIdentityEvidence(f.song,f.performers,f.target,f.profiles,contradictory),null);
 f.catalog.entities.Q8001.claims.P10445=[claim('27')];
 const exactID=await createArtistIdentityResolver({fetchFn:f.catalog.fetchFn})(f.recording.metadata.artist_ids);
 assert.ok(buildArtistIdentityEvidence(f.song,f.performers,f.target,new Map([['27',[f.song.artist]]]),exactID));
});
test('external aliases preserve version, album, duration, explicitness and complete contributor gates',async()=>{
 const f=await fixture();
 for(const changed of [{title:f.song.title+' (Live)'},{album:'Other Album'},{duration:244},{explicit:true},{isrc:'JPABC2600001'},
  {creditedArtistNames:[f.song.artist,'Guest']}]) {
  const target={...f.target,explicit:false,isrc:'JPABC2600002'};
  assert.equal(buildArtistIdentityEvidence({...f.song,...changed},f.performers,target,f.profiles,f.identities),null,JSON.stringify(changed));
 }
 const proof=buildArtistIdentityEvidence(f.song,f.performers,f.target,f.profiles,f.identities);
 for(const mutate of [e=>{e.performers[0].identity.names.push('Forged');},e=>{e.performers[0].id='99';},
  e=>{e.performers[0].requestedID='2123456789ABCDEFGHIJKL';},e=>{e.performers[0].identity.entityID='Q99';},
  e=>{e.request.artistIDs=['2123456789ABCDEFGHIJKL'];}]) {
  const changed=structuredClone(proof);mutate(changed);assert.equal(recordingScore({...f.song,artistAliasEvidence:changed},f.target),-1);
 }
});
test('duets require a unique one-to-one assignment; two plausible identities cannot choose a performer arbitrarily',async()=>{
 const f=await fixture(),g=await fixture(cases[1]);
 const recording={...f.recording,metadata:{...f.recording.metadata,artists:[...f.recording.metadata.artists,...g.recording.metadata.artists],artist_ids:['1123456789ABCDEFGHIJKL','2123456789ABCDEFGHIJKL']}};
 const performers=[...f.performers,{id:28,name:g.song.artist}],profiles={27:{id:27,name:f.song.artist,alias:['Aoba Haruka']},28:{id:28,name:g.song.artist,alias:['Kim Ha Neul']}};
 const catalog=identityCatalog(recording,{artists:performers},profiles),identities=await createArtistIdentityResolver({fetchFn:catalog.fetchFn})(recording.metadata.artist_ids);
 const song={...f.song,artist:performers.map(p=>p.name).join(' & '),creditedArtistNames:performers.map(p=>p.name),creditedArtistIDs:performers.map(p=>String(p.id))},target=spotifySearchRequest(recording);
 const names=new Map(Object.values(profiles).map(p=>[String(p.id),[p.name,...p.alias]]));
 assert.ok(buildArtistIdentityEvidence(song,performers,target,names,identities));
 assert.equal(buildArtistIdentityEvidence(song,performers,{...target,creditedArtistIDs:[...target.creditedArtistIDs].reverse()},names,identities),null);
 const allNames=Object.values(profiles).flatMap(p=>[p.name,...p.alias]);
 for(const entity of Object.values(catalog.entities))entity.aliases.native=allNames.map(value=>({value}));
 const ambiguous=await createArtistIdentityResolver({fetchFn:catalog.fetchFn})(recording.metadata.artist_ids);
 assert.equal(buildArtistIdentityEvidence(song,performers,target,names,ambiguous),null);
});
