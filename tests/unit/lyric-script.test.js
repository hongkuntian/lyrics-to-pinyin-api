import test from 'node:test';
import assert from 'node:assert/strict';
import {lyricScriptFit} from '../../api/utils/lyric-script.js';

const fit=(title,text)=>lyricScriptFit({target:{title},lyrics:{lines:[{text}]}});
test('script preference recognizes Japanese kanji titles and unrelated scripts conservatively',()=>{
 assert.equal(fit('日本語','これはテストの歌詞'),1);
 assert.equal(fit('ひかり','光'),1);
 assert.equal(fit('紅日','Meng wan jau shuin'),-1);
 assert.equal(fit('紅日','Ελληνικά'),0);
 assert.equal(fit('Песня','Другие слова'),1);
 assert.equal(fit('أغنية','كلمات الأغنية'),1);
 assert.equal(fit('Red Sun','English lyrics'),0);
 assert.equal(fit('Canción','Una canción para ti'),0);
 assert.equal(fit('紅日','原文 English refrain'),1);
 assert.equal(fit('紅日','123 ...'),0);
 assert.equal(lyricScriptFit(null),0);
});
