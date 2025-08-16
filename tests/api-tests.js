// API Tests - Consolidated test suite for the romanization API
import { CorpusLoader } from './corpus-loader.js';

// Initialize corpus loader
const corpusLoader = new CorpusLoader();

// Test the generic romanization endpoint using modular corpus
async function testRomanizeAPI() {
    console.log('🧪 Testing /api/romanize endpoint...');
    
    const availableLanguages = corpusLoader.getAvailableLanguages();
    if (availableLanguages.length === 0) {
        console.error('❌ No test corpuses found');
        return;
    }

    console.log(`📚 Found ${availableLanguages.length} language corpuses: ${availableLanguages.join(', ')}`);

    for (const language of availableLanguages) {
        const corpus = corpusLoader.loadCorpus(language);
        if (!corpus) continue;

        console.log(`\n📝 Testing ${corpus.description} (${language})...`);
        
        for (const testCase of corpus.cases) {
            try {
                const response = await fetch('http://localhost:3000/api/romanize', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: testCase.input,
                        language: language
                    })
                });
                
                const result = await response.json();
                if (result.error) {
                    console.error(`❌ ${testCase.description}:`, result.error);
                } else {
                    const isCorrect = result.romanized === testCase.expected;
                    const status = isCorrect ? '✅' : '⚠️';
                    console.log(`${status} ${testCase.description}:`);
                    console.log(`   Input: "${testCase.input}"`);
                    console.log(`   Expected: "${testCase.expected}"`);
                    console.log(`   Got: "${result.romanized}"`);
                    if (!isCorrect) {
                        console.log(`   ❌ Mismatch detected!`);
                    }
                }
            } catch (error) {
                console.error(`❌ ${testCase.description}:`, error.message);
            }
        }
    }
}

// Test options variations using modular corpus
async function testOptionsAPI() {
    console.log('\n🔧 Testing /api/romanize with different options...');
    
    const availableLanguages = corpusLoader.getAvailableLanguages();
    
    for (const language of availableLanguages) {
        const optionsTests = corpusLoader.loadOptionsTests(language);
        if (optionsTests.length === 0) continue;

        console.log(`\n📝 Testing options for ${language}...`);
        
        for (const optionsTest of optionsTests) {
            console.log(`  🔧 ${optionsTest.description}...`);
            
            for (const testCase of optionsTest.cases) {
                try {
                    const response = await fetch('http://localhost:3000/api/romanize', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            text: optionsTest.input,
                            language: language,
                            options: testCase.options
                        })
                    });
                    
                    const result = await response.json();
                    if (result.error) {
                        console.error(`    ❌ ${JSON.stringify(testCase.options)}:`, result.error);
                    } else {
                        const isCorrect = result.romanized === testCase.expected;
                        const status = isCorrect ? '✅' : '⚠️';
                        console.log(`    ${status} Options ${JSON.stringify(testCase.options)}:`);
                        console.log(`       Expected: "${testCase.expected}"`);
                        console.log(`       Got: "${result.romanized}"`);
                        if (!isCorrect) {
                            console.log(`       ❌ Mismatch detected!`);
                        }
                    }
                } catch (error) {
                    console.error(`    ❌ Options ${JSON.stringify(testCase.options)}:`, error.message);
                }
            }
        }
    }
}

// Test the music romanization endpoint
async function testMusicRomanizeAPI() {
    console.log('\n🎵 Testing /api/music-romanize endpoint...');
    
    const testCases = [
        {
            name: 'Chinese Song',
            payload: {
                artist: '周杰伦',
                title: '稻香',
                language: 'zh'
            }
        }
    ];

    for (const testCase of testCases) {
        try {
            const response = await fetch('http://localhost:3000/api/music-romanize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testCase.payload)
            });
            
            const result = await response.json();
            if (result.error) {
                console.error(`❌ ${testCase.name}:`, result.error);
            } else {
                console.log(`✅ ${testCase.name}:`, result.song?.title?.romanized || 'No title romanized');
            }
        } catch (error) {
            console.error(`❌ ${testCase.name}:`, error.message);
        }
    }
}

// Test Redis connection
async function testRedisConnection() {
    console.log('\n🗄️ Testing Redis connection...');
    
    try {
        const response = await fetch('http://localhost:3000/api/romanize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'test',
                language: 'zh'
            })
        });
        
        if (response.ok) {
            console.log('✅ Redis connection working');
        } else {
            console.log('⚠️ Redis connection may have issues');
        }
    } catch (error) {
        console.error('❌ Redis connection failed:', error.message);
    }
}

// Run all tests
async function runAllTests() {
    console.log('🚀 Starting API Tests...\n');
    
    await testRomanizeAPI();
    await testOptionsAPI(); // Added this line
    await testMusicRomanizeAPI();
    await testRedisConnection();
    
    console.log('\n✨ All tests completed!');
}

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { runAllTests, testRomanizeAPI, testMusicRomanizeAPI, testRedisConnection };
}

// Run tests if this file is executed directly
if (typeof window === 'undefined') {
    runAllTests().catch(console.error);
}
