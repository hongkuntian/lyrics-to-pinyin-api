#!/usr/bin/env node

// Music Romanization Tests - Comprehensive test suite for music API
import { CorpusLoader } from './corpus-loader.js';

const corpusLoader = new CorpusLoader();

// Test music romanization for different languages and scenarios
async function testMusicRomanization() {
    console.log('🎵 Testing Music Romanization API...\n');

    const testCases = [
        {
            name: 'Chinese Song - 周杰伦 稻香',
            payload: {
                artist: '周杰伦',
                title: '稻香',
                language: 'zh'
            },
            expected: {
                hasSong: true,
                hasLyrics: true,
                titleRomanized: true,
                artistRomanized: true,
                syncedLyrics: true
            }
        },
        {
            name: 'Chinese Song - Different Artist',
            payload: {
                artist: '林俊杰',
                title: '江南',
                language: 'zh'
            },
            expected: {
                hasSong: true,
                hasLyrics: true,
                titleRomanized: true,
                artistRomanized: true,
                syncedLyrics: true
            }
        },
        {
            name: 'Cantonese Song',
            payload: {
                artist: '陈奕迅',
                title: '富士山下',
                language: 'yue'
            },
            expected: {
                hasSong: true,
                hasLyrics: true,
                titleRomanized: true,
                artistRomanized: true,
                syncedLyrics: true
            }
        },
        {
            name: 'Japanese Song (Should Fail - No API)',
            payload: {
                artist: '宇多田ヒカル',
                title: 'First Love',
                language: 'ja'
            },
            expected: {
                shouldFail: true,
                errorType: 'no_api_available'
            }
        },
        {
            name: 'Korean Song (Should Fail - No API)',
            payload: {
                artist: 'BTS',
                title: 'Dynamite',
                language: 'ko'
            },
            expected: {
                shouldFail: true,
                errorType: 'no_api_available'
            }
        },
        {
            name: 'Non-existent Song',
            payload: {
                artist: 'NonExistentArtist',
                title: 'NonExistentSong',
                language: 'zh'
            },
            expected: {
                shouldFail: true,
                errorType: 'song_not_found'
            }
        }
    ];

    let passedTests = 0;
    let totalTests = testCases.length;

    for (const testCase of testCases) {
        console.log(`📝 Testing: ${testCase.name}`);
        
        try {
            const startTime = Date.now();
            const response = await fetch('http://localhost:3000/api/music-romanize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testCase.payload)
            });
            
            const result = await response.json();
            const responseTime = Date.now() - startTime;

            if (testCase.expected.shouldFail) {
                // Expected to fail
                if (result.error) {
                    console.log(`✅ Expected failure: ${result.error}`);
                    passedTests++;
                } else {
                    console.log(`❌ Expected failure but got success`);
                    console.log(`   Response:`, JSON.stringify(result, null, 2));
                }
            } else {
                // Expected to succeed
                if (result.error) {
                    console.log(`❌ Unexpected error: ${result.error}`);
                } else {
                    const validation = validateMusicResponse(result, testCase.expected);
                    if (validation.success) {
                        console.log(`✅ Success (${responseTime}ms)`);
                        console.log(`   Title: "${result.song.title.original}" → "${result.song.title.romanized}"`);
                        console.log(`   Artist: "${result.song.artist.original}" → "${result.song.artist.romanized}"`);
                        console.log(`   Lyrics: ${result.lines.length} lines`);
                        console.log(`   Synced: ${result.quality.synced ? 'Yes' : 'No'}`);
                        passedTests++;
                    } else {
                        console.log(`⚠️ Partial success: ${validation.issues.join(', ')}`);
                        console.log(`   Response:`, JSON.stringify(result, null, 2));
                    }
                }
            }
        } catch (error) {
            console.log(`❌ Network error: ${error.message}`);
        }
        
        console.log(''); // Empty line for readability
    }

    console.log(`📊 Results: ${passedTests}/${totalTests} tests passed`);
    return passedTests === totalTests;
}

// Validate music response structure
function validateMusicResponse(result, expected) {
    const issues = [];

    if (expected.hasSong && !result.song) {
        issues.push('Missing song object');
    }

    if (expected.titleRomanized && (!result.song?.title?.romanized || result.song.title.romanized === result.song.title.original)) {
        issues.push('Title not romanized');
    }

    if (expected.artistRomanized && (!result.song?.artist?.romanized || result.song.artist.romanized === result.song.artist.original)) {
        issues.push('Artist not romanized');
    }

    if (expected.hasLyrics && (!result.lines || result.lines.length === 0)) {
        issues.push('No lyrics found');
    }

    if (expected.syncedLyrics && (!result.quality?.synced)) {
        issues.push('Lyrics not synced');
    }

    return {
        success: issues.length === 0,
        issues
    };
}

// Test music API performance
async function testMusicAPIPerformance() {
    console.log('⚡ Testing Music API Performance...\n');

    const testCases = [
        { artist: '周杰伦', title: '稻香', language: 'zh' },
        { artist: '林俊杰', title: '江南', language: 'zh' },
        { artist: '陈奕迅', title: '富士山下', language: 'yue' }
    ];

    const results = [];

    for (const testCase of testCases) {
        try {
            const startTime = Date.now();
            const response = await fetch('http://localhost:3000/api/music-romanize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testCase)
            });
            
            const result = await response.json();
            const responseTime = Date.now() - startTime;

            if (!result.error) {
                results.push({
                    song: `${testCase.artist} - ${testCase.title}`,
                    time: responseTime,
                    lyricsCount: result.lines?.length || 0,
                    success: true
                });
            } else {
                results.push({
                    song: `${testCase.artist} - ${testCase.title}`,
                    time: responseTime,
                    error: result.error,
                    success: false
                });
            }
        } catch (error) {
            results.push({
                song: `${testCase.artist} - ${testCase.title}`,
                error: error.message,
                success: false
            });
        }
    }

    // Display performance results
    const successfulResults = results.filter(r => r.success);
    if (successfulResults.length > 0) {
        const avgTime = successfulResults.reduce((sum, r) => sum + r.time, 0) / successfulResults.length;
        const avgLyrics = successfulResults.reduce((sum, r) => sum + r.lyricsCount, 0) / successfulResults.length;
        
        console.log(`📊 Performance Summary:`);
        console.log(`   Average response time: ${avgTime.toFixed(0)}ms`);
        console.log(`   Average lyrics per song: ${avgLyrics.toFixed(0)} lines`);
        console.log(`   Success rate: ${successfulResults.length}/${results.length} (${(successfulResults.length/results.length*100).toFixed(0)}%)`);
    }

    // Display individual results
    results.forEach(result => {
        const status = result.success ? '✅' : '❌';
        const timeInfo = result.success ? `(${result.time}ms, ${result.lyricsCount} lines)` : `(${result.error})`;
        console.log(`${status} ${result.song} ${timeInfo}`);
    });
}

// Run music tests
async function runMusicTests() {
    console.log('🚀 Starting Music Romanization Tests...\n');
    
    const basicTestsPassed = await testMusicRomanization();
    console.log('\n' + '='.repeat(50) + '\n');
    await testMusicAPIPerformance();
    
    console.log('\n✨ Music tests completed!');
    return basicTestsPassed;
}

// Run if executed directly
if (typeof window === 'undefined') {
    runMusicTests().catch(console.error);
}
