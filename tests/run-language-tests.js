#!/usr/bin/env node

// Run tests for specific languages
import { CorpusLoader } from './corpus-loader.js';

const corpusLoader = new CorpusLoader();

async function testSpecificLanguage(language) {
    console.log(`🧪 Testing ${language} only...`);
    
    const corpus = corpusLoader.loadCorpus(language);
    if (!corpus) {
        console.error(`❌ No corpus found for ${language}`);
        return;
    }

    console.log(`📝 Testing ${corpus.description}...`);
    
    // Test basic cases
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

    // Test options if available
    const optionsTests = corpusLoader.loadOptionsTests(language);
    if (optionsTests.length > 0) {
        console.log(`\n🔧 Testing options for ${language}...`);
        
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

// Get command line arguments
const args = process.argv.slice(2);
const language = args[0];

if (!language) {
    console.log('Usage: node tests/run-language-tests.js <language>');
    console.log('Available languages:', corpusLoader.getAvailableLanguages().join(', '));
    process.exit(1);
}

// Validate language exists
const availableLanguages = corpusLoader.getAvailableLanguages();
if (!availableLanguages.includes(language)) {
    console.error(`❌ Language '${language}' not found`);
    console.log('Available languages:', availableLanguages.join(', '));
    process.exit(1);
}

// Run the test
testSpecificLanguage(language).catch(console.error);
