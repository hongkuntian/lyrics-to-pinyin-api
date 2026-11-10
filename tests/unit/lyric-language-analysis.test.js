import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeLyricLanguage} from '../../api/utils/lyric-language.js';
test('Spanish lyrics are independent of English catalog metadata',()=>{
 const result=analyzeLyricLanguage(['Esta noche caminamos juntos por la ciudad y hablamos de nuestros recuerdos.','Quiero volver a verte cuando salga el sol, porque todavía pienso en ti.']);
 assert.equal(result.primary,'es');assert.equal(result.pronunciation_language,null);
});
test('Han alone leaves pronunciation unresolved; authoritative recording genre may resolve it',()=>{
 const lines=['今天我看著天空想起遠方的人','明天還要繼續走過這條路'];
 assert.equal(analyzeLyricLanguage(lines).pronunciation_language,null);
 assert.equal(analyzeLyricLanguage(lines,{genres:['Cantopop'],verified:true}).pronunciation_language,'yue');
 assert.equal(analyzeLyricLanguage(lines,{genres:['Mandopop'],verified:true}).pronunciation_language,'zh');
 assert.equal(analyzeLyricLanguage(lines,{genres:['Cantopop'],verified:false}).pronunciation_language,null);
});
test('Japanese, Korean, Cyrillic and mixed passages retain their source scripts',()=>{
 assert.equal(analyzeLyricLanguage(['夜に歩いて君の声を聞いている']).primary,'ja');
 assert.equal(analyzeLyricLanguage(['오늘 밤 우리는 함께 길을 걸으며 이야기합니다']).primary,'ko');
 assert.equal(analyzeLyricLanguage(['Сегодня мы вместе идём по улице и вспоминаем далёкие дни. Когда наступает вечер, я думаю о том, как много времени прошло с нашей последней встречи. Мы снова будем говорить о жизни, о друзьях и о будущем, которое ждёт нас впереди.']).primary,'ru');
 assert.equal(analyzeLyricLanguage(['Сегодня мы вместе идём по улице.']).primary,'und');
 const mixed=analyzeLyricLanguage(['夜に歩いて君の声を聞いている','We remember all the days we spent together and the promises we made.']);
 assert.equal(mixed.mixed,true);assert.deepEqual(mixed.scripts,['Jpan','Latn']);
});
test('English passages do not erase verified Mandarin pronunciation for the Han words',()=>{
 const lines=['今天我看著天空想起遠方的人','明天還要繼續走過這條路','We remember everything together','I will keep singing all these words'];
 const result=analyzeLyricLanguage(lines,{genres:['Mandopop'],verified:true});
 assert.equal(result.mixed,true);assert.equal(result.pronunciation_language,'zh');
});

test('Hindi in Latin letters is labelled hi-Latn without catching other Latin-script lyrics',()=>{
 const hindi=['Khidki maine nahin kholi.','Tumne kaha "kal", par yeh nahin kaha ki kiska kal.','Shayad baat baarish ki thi.','Subah main tumse rukne ko nahin kehta.'];
 const result=analyzeLyricLanguage(hindi);
 assert.equal(result.primary,'hi-Latn');assert.equal(result.mixed,false);assert.equal(result.pronunciation_language,null);
 assert.deepEqual([...new Set(result.lines.map(l=>l.language))],['hi-Latn']);
 for(const lines of [['I want to be with you tonight','Hold me close and never let go','Dancing on the floor until the morning comes'],
  ['Mahal kita, hindi kita iiwan','Ikaw ang aking mundo at buhay','Huwag kang lumayo sa akin'],
  ['Aku cinta padamu selamanya','Jangan pergi tinggalkan diriku','Kau bintang di langit malam'],
  ['Không phải em đã mở cửa sổ','Anh nói ngày mai nhưng ngày mai của ai']])
  assert.notEqual(analyzeLyricLanguage(lines).primary,'hi-Latn');
 assert.notEqual(analyzeLyricLanguage(['मैं तुमसे रुकने को नहीं कहता','Main tumse rukne ko nahin kehta hoon aur kya']).primary,'hi-Latn');
});
test('Indonesian and Malay near-ties resolve by marker words, defaulting to Indonesian',()=>{
 // Original authored lines, not taken from any song.
 const indonesianPoetic=['Bila malam datang aku takkan pergi','Kau bilang rindu ini cuma sementara','Tapi hatiku tak bisa melupakanmu','Biar bintang menjaga mimpi kita','Aku masih menunggu kabar darimu','Karena hanya kamu yang kucari','Jangan biarkan aku sendiri lagi','Kapan kau kembali ke kota ini'];
 const indonesianCasual=['Udah lama banget kita nggak ketemu','Kamu kok diam aja dari tadi','Gimana kabarmu di sana sekarang','Aku kangen suara kamu yang dulu','Jangan bilang semua udah selesai','Kita jalan bareng lagi besok sore','Aku nggak mau kehilangan kamu','Sumpah aku masih sayang kamu'];
 const malayCasual=['Awak tahu tak betapa aku rindu','Jom kita jalan sikit malam ni','Aku nak dengar suara awak lagi','Dah lama kita tak berjumpa','Pasal awak aku tak boleh tidur','Hati ni masih sayang kat awak','Jangan pergi petang tu tanpa kata','Aku mahu awak tahu semuanya'];
 const malayStandard=['Kerana engkau aku masih di sini','Sahaja mahu melihat senyumanmu','Walau tingkap hatiku telah tertutup','Aku faham kau perlukan masa','Kenangan petang itu masih segar','Kau nak aku tunggu sampai bila','Kasih ini takkan pudar','Selamanya aku setia padamu'];
 for(const lines of [indonesianPoetic,indonesianCasual]){const result=analyzeLyricLanguage(lines);assert.equal(result.primary,'id',lines[0]);assert.equal(result.mixed,false);}
 for(const lines of [malayCasual,malayStandard]){const result=analyzeLyricLanguage(lines);assert.equal(result.primary,'ms',lines[0]);assert.equal(result.mixed,false);assert.ok(result.lines.every(l=>['ms','und'].includes(l.language)));}
 assert.equal(analyzeLyricLanguage(['Esta noche caminamos juntos por la ciudad y hablamos de nuestros recuerdos.','Quiero volver a verte cuando salga el sol, porque todavía pienso en ti.']).primary,'es');
 // The detector's own choice between the two follows the topic, not the standard:
 // these authored Indonesian lines score as Malay. Without Malay words they stay Indonesian.
 const indonesianFormal=['Cinta ini tumbuh perlahan di dalam hati','Seperti bunga yang mekar di pagi hari','Setiap detik bersamamu terasa begitu indah','Aku ingin selalu berada di sisimu','Janganlah engkau ragu akan kesetiaanku','Selamanya aku akan menjagamu'];
 assert.equal(analyzeLyricLanguage(indonesianFormal).primary,'id');
 // Standard spelling pairs decide formal lyrics either way.
 assert.equal(analyzeLyricLanguage(['Karena engkau aku masih percaya pada cinta','Aku tahu bahwa hatimu senantiasa di sini','Setelah hujan berhenti kita berjalan lagi','Jangan kau pikir aku akan melupakanmu']).primary,'id');
 assert.equal(analyzeLyricLanguage(['Kerana engkau aku masih percaya pada cinta','Aku tahu bahawa hatimu sentiasa di sini','Selepas hujan berhenti kita berjalan lagi','Jangan kau fikir aku akan melupakanmu']).primary,'ms');
 // One Malay word with none Indonesian counts where the detector also leans Malay.
 const malayFormal=['Cinta ini berputik perlahan di dalam hati','Umpama bunga yang mekar di waktu pagi','Setiap detik bersamamu terasa begitu indah','Aku ingin sentiasa berada di sisimu','Usahlah engkau ragu akan kesetiaanku','Selamanya aku akan menjagamu'];
 assert.equal(analyzeLyricLanguage(malayFormal).primary,'ms');
 // A verified catalog genre settles lyrics with no marker words; an unverified one is ignored.
 const unmarked=['Aku berjalan seorang diri dalam hujan malam ini','Terkenang segala yang pernah kita lalui','Senyumanmu masih terbayang di setiap langkahku','Dan aku berharap masa dapat diundur kembali','Namun kau telah memilih haluan yang berlainan','Meninggalkan aku dengan sejuta kenangan'];
 assert.equal(analyzeLyricLanguage(unmarked).primary,'id');
 assert.equal(analyzeLyricLanguage(unmarked,{genres:['Malaysian Pop','Music'],verified:true}).primary,'ms');
 assert.equal(analyzeLyricLanguage(unmarked,{genres:['Malaysian Pop'],verified:false}).primary,'id');
 assert.equal(analyzeLyricLanguage(malayFormal,{genres:['Indo Pop'],verified:true}).primary,'id');
 assert.equal(analyzeLyricLanguage(malayCasual,{genres:['Indo Pop'],verified:true}).primary,'ms','marker words outrank the genre');
 assert.equal(analyzeLyricLanguage(['Esta noche caminamos juntos por la ciudad y hablamos de nuestros recuerdos.','Quiero volver a verte cuando salga el sol, porque todavía pienso en ti.'],{genres:['Malaysian Pop'],verified:true}).primary,'es');
});
