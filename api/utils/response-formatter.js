// Response formatter utility for consistent API responses

export function formatResponse(data) {
  const {
    original,
    romanized,
    language,
    romanization_system,
    confidence,
    spans = [],
    metadata = {}
  } = data;

  return {
    original,
    romanized,
    language,
    romanization_system,
    confidence,
    spans, // Optional spans field for alignment (future expansion)
    metadata: {
      timestamp: new Date().toISOString(),
      version: "2.0.0",
      ...metadata
    }
  };
}

export function formatErrorResponse(error, statusCode = 500) {
  return {
    error: {
      message: error.message || "An error occurred",
      code: statusCode,
      timestamp: new Date().toISOString(),
      version: "2.0.0"
    }
  };
}

export function formatBatchResponse(results) {
  return {
    results,
    summary: {
      total: results.length,
      successful: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      timestamp: new Date().toISOString(),
      version: "2.0.0"
    }
  };
}

export function formatMusicResponse(songData, romanizedData) {
  return {
    song: {
      title: {
        original: songData.title,
        romanized: romanizedData.title
      },
      artist: {
        original: songData.artist,
        romanized: romanizedData.artist
      },
      id: songData.id,
      language: romanizedData.language,
      romanization_system: romanizedData.system
    },
    lines: romanizedData.lines || [],
    quality: {
      synced: romanizedData.lines?.some(line => line.timestamp !== null) || false
    },
    metadata: {
      timestamp: new Date().toISOString(),
      version: "2.0.0",
      source: songData.source || "unknown"
    }
  };
}

// Validation utilities
export function validateRomanizationRequest(body) {
  const errors = [];

  if (!body.text && !body.artist && !body.title) {
    errors.push("Either 'text' or both 'artist' and 'title' must be provided");
  }

  if (body.language && !isValidScriptCode(body.language)) {
    errors.push("Invalid script code format");
  }

  if (body.romanization_system && !isValidRomanizationSystem(body.romanization_system)) {
    errors.push("Invalid romanization system");
  }

  // Validate options
  if (body.options) {
    const optionErrors = validateOptions(body.options);
    errors.push(...optionErrors);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

function validateOptions(options) {
  const errors = [];

  // Validate tone_style for Chinese languages
  if (options.tone_style && !['marks', 'numbers', 'none'].includes(options.tone_style)) {
    errors.push("tone_style must be 'marks', 'numbers', or 'none'");
  }

  // Validate case
  if (options.case && !['lower', 'upper', 'title'].includes(options.case)) {
    errors.push("case must be 'lower', 'upper', or 'title'");
  }

  // Validate separator
  if (options.separator && typeof options.separator !== 'string') {
    errors.push("separator must be a string");
  }

  // Validate normalize_variants
  if (options.normalize_variants !== undefined && typeof options.normalize_variants !== 'boolean') {
    errors.push("normalize_variants must be a boolean");
  }

  // Validate long_vowels for Japanese
  if (options.long_vowels && !['macron', 'circumflex', 'double'].includes(options.long_vowels)) {
    errors.push("long_vowels must be 'macron', 'circumflex', or 'double'");
  }

  return errors;
}

function isValidScriptCode(code) {
  const validCodes = ['zh', 'yue', 'ja', 'ko', 'ru', 'en'];
  return validCodes.includes(code);
}

function isValidRomanizationSystem(system) {
  const validSystems = [
    'pinyin', 'jyutping', 'hepburn', 'revised', 'iso-9', 'bgn-pcgn',
    'none' // For scripts that don't need romanization
  ];
  return validSystems.includes(system);
}
