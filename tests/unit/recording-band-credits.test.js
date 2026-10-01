import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingNames,sameRecordingNames} from '../../api/utils/recording-match.js';
test('the punctuated Dick & Cowboy stage name preserves all additional guests',()=>{
 assert.deepEqual(recordingNames({artist:'Dick & Cowboy',title:'有多少愛可以重來'}).credits,['dickcowboy']);
 assert.equal(sameRecordingNames({artist:'Dick & Cowboy',title:'Song'},{artist:'迪克牛仔',title:'Song'}),false);
 assert.deepEqual(recordingNames({artist:'Dick & Cowboy & Guest',title:'Song'}).credits,['dickcowboy','guest']);
 assert.deepEqual(recordingNames({artist:'Dick & Cowboy',title:'Song (feat. Guest)'}).credits,['dickcowboy','guest']);
 assert.deepEqual(recordingNames({artist:'Dick & Guest',title:'Song'}).credits,['dick','guest']);
});
