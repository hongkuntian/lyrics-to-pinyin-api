// Corpus Loader - Loads test corpus files dynamically
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class CorpusLoader {
    constructor(corpusDir = join(__dirname, 'corpus')) {
        this.corpusDir = corpusDir;
        this.cache = new Map();
    }

    // Load all available language corpuses
    loadAllCorpuses() {
        try {
            const files = readdirSync(this.corpusDir)
                .filter(file => file.endsWith('.json'))
                .map(file => file.replace('.json', ''));

            const corpuses = {};
            for (const language of files) {
                corpuses[language] = this.loadCorpus(language);
            }
            return corpuses;
        } catch (error) {
            console.error('❌ Failed to load corpuses:', error.message);
            return {};
        }
    }

    // Load corpus for a specific language
    loadCorpus(language) {
        if (this.cache.has(language)) {
            return this.cache.get(language);
        }

        try {
            const corpusPath = join(this.corpusDir, `${language}.json`);
            const corpusData = readFileSync(corpusPath, 'utf8');
            const corpus = JSON.parse(corpusData);
            
            this.cache.set(language, corpus);
            return corpus;
        } catch (error) {
            console.error(`❌ Failed to load corpus for ${language}:`, error.message);
            return null;
        }
    }

    // Get list of available languages
    getAvailableLanguages() {
        try {
            return readdirSync(this.corpusDir)
                .filter(file => file.endsWith('.json'))
                .map(file => file.replace('.json', ''));
        } catch (error) {
            console.error('❌ Failed to get available languages:', error.message);
            return [];
        }
    }

    // Load specific test cases for a language
    loadTestCases(language) {
        const corpus = this.loadCorpus(language);
        return corpus?.cases || [];
    }

    // Load options tests for a language
    loadOptionsTests(language) {
        const corpus = this.loadCorpus(language);
        return corpus?.options_tests || [];
    }

    // Validate corpus structure
    validateCorpus(language) {
        const corpus = this.loadCorpus(language);
        if (!corpus) return false;

        const required = ['language', 'description', 'cases'];
        const hasRequired = required.every(field => corpus.hasOwnProperty(field));
        
        if (!hasRequired) {
            console.error(`❌ Corpus for ${language} missing required fields:`, required);
            return false;
        }

        if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
            console.error(`❌ Corpus for ${language} has no test cases`);
            return false;
        }

        return true;
    }
}
