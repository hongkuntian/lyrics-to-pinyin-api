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
