// Language detection utility for MVP - five core languages
// In production, you'd use a proper library like 'franc' or 'langdetect'

// Script-based language codes for MVP
const languagePatterns = {
  'zh': /[\u4e00-\u9fff]/, // Chinese characters (Mandarin)
  'yue': /[\u4e00-\u9fff]/, // Chinese characters (Cantonese - same range, context needed)
  'ja': /[\u3040-\u309f\u30a0-\u30ff]/, // Hiragana and Katakana
  'ko': /[\uac00-\ud7af]/, // Hangul
  'ru': /[\u0400-\u04ff]/, // Cyrillic
  'en': /[a-zA-Z]/, // English/Latin script
};

const confidenceThresholds = {
  'zh': 0.8,
  'yue': 0.8,
  'ja': 0.9,
  'ko': 0.9,
  'ru': 0.9,
  'en': 0.7,
};

// Mapping from script codes to romanization systems
const scriptToRomanizationMap = {
  'zh': ['pinyin'],
  'yue': ['jyutping'],
  'ja': ['hepburn'],
  'ko': ['revised'],
  'ru': ['iso-9', 'bgn-pcgn'],
  'en': ['none'] // No romanization needed
};

export async function detectLanguage(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid text input for language detection');
  }

  const scores = {};
  let totalChars = 0;

  // Count characters for each script
  for (const [script, pattern] of Object.entries(languagePatterns)) {
    const matches = text.match(pattern);
    const count = matches ? matches.length : 0;
    scores[script] = count;
    totalChars += count;
  }

  // If no script-specific characters found, try to detect based on context
  if (totalChars === 0) {
    return detectLanguageByContext(text);
  }

  // Calculate confidence scores
  const confidenceScores = {};
  for (const [script, count] of Object.entries(scores)) {
    if (count > 0) {
      confidenceScores[script] = count / totalChars;
    }
  }

  // Find the script with highest confidence
  let bestScript = null;
  let bestScore = 0;

  for (const [script, score] of Object.entries(confidenceScores)) {
    if (score > bestScore && score >= confidenceThresholds[script]) {
      bestScore = score;
      bestScript = script;
    }
  }

  // If no script meets threshold, return the most likely
  if (!bestScript && Object.keys(confidenceScores).length > 0) {
    bestScript = Object.entries(confidenceScores)
      .sort(([,a], [,b]) => b - a)[0][0];
  }

  // For Chinese characters, try to distinguish between Mandarin and Cantonese
  if (bestScript === 'zh' || bestScript === 'yue') {
    bestScript = distinguishChineseDialect(text);
  }

  return bestScript || 'en'; // Default to English if no detection
}

function distinguishChineseDialect(text) {
  // Simple heuristics to distinguish Mandarin vs Cantonese
  // In production, you'd use more sophisticated methods
  
  // Check for Cantonese-specific characters/patterns
  const cantonesePatterns = [
    /[嘅咗咁啲嘢]/g, // Common Cantonese particles
    /[唔係]/g,      // Cantonese negation
    /[佢哋]/g       // Cantonese pronouns
  ];
  
  const cantoneseMatches = cantonesePatterns.reduce((count, pattern) => {
    return count + (text.match(pattern) || []).length;
  }, 0);
  
  // If we find Cantonese-specific patterns, return 'yue'
  if (cantoneseMatches > 0) {
    return 'yue';
  }
  
  // Default to Mandarin for Chinese characters
  return 'zh';
}

function detectLanguageByContext(text) {
  // Simple context-based detection for edge cases
  const lowerText = text.toLowerCase();
  
  // Check for common words/patterns
  if (/\b(你好|谢谢|再见|中国|中文|不对|很好|一共有)\b/.test(text)) {
    return 'zh'; // Mandarin
  }
  
  if (/\b(行|更|嘅|咗|咁|啲|嘢|唔係|佢哋)\b/.test(text)) {
    return 'yue'; // Cantonese
  }
  
  if (/\b(こんにちは|ありがとう|さようなら|日本|日本語)\b/.test(text)) {
    return 'ja';
  }
  
  if (/\b(안녕하세요|감사합니다|안녕히|한국|한국어|국물)\b/.test(text)) {
    return 'ko';
  }
  
  if (/\b(привет|спасибо|до свидания|русский|Россия)\b/.test(text)) {
    return 'ru';
  }
  
  return 'en'; // Default fallback
}

export function getSupportedLanguages() {
  return Object.keys(languagePatterns);
}

export function isLanguageSupported(languageCode) {
  return languageCode in languagePatterns;
}

export function getRomanizationSystems(scriptCode) {
  return scriptToRomanizationMap[scriptCode] || [];
}

export function getDefaultRomanizationSystem(scriptCode) {
  const systems = getRomanizationSystems(scriptCode);
  return systems[0] || 'none';
}
