import { BaseProcessor } from "./base.js";

export class CantoneseProcessor extends BaseProcessor {
  constructor() {
    super("CantoneseProcessor", ["jyutping"]);
  }

  async romanize(text, system = "jyutping", options = {}) {
    const {
      separator = " ",
      case: caseOption = "lower"
    } = options;

    let romanized;
    let confidence = 0.90;
    let spans = [];

    try {
      // Convert to Jyutping (always with tone numbers)
      romanized = this.toJyutping(text, { separator, case: caseOption });

      // Generate spans for alignment
      spans = this.generateSpans(text, romanized, "yue");

      return {
        romanized,
        system,
        confidence,
        spans
      };
    } catch (error) {
      console.error("Cantonese romanization error:", error);
      throw new Error(`Failed to romanize Cantonese text: ${error.message}`);
    }
  }

  toJyutping(text, options) {
    const { separator, case: caseOption } = options;
    
    // This is a simplified implementation
    // In production, you'd use jyutping (npm) or cantonese.js dictionaries
    let result = this.basicJyutpingConversion(text);
    result = result.join(separator);
    
    // Apply case
    if (caseOption === "title") {
      result = result.replace(/\b\w/g, l => l.toUpperCase());
    } else if (caseOption === "upper") {
      result = result.toUpperCase();
    }
    
    return result;
  }

  basicJyutpingConversion(text) {
    // Simplified Jyutping conversion for common characters
    // In production, you'd use a proper Jyutping library
    const jyutpingMap = {
      // Common Cantonese characters with their Jyutping readings
      '嘅': 'ge3', '咗': 'zo2', '咁': 'gam3', '啲': 'di1', '嘢': 'je5',
      '唔': 'm4', '係': 'hai6', '佢': 'keoi5', '哋': 'dei6',
      '行': 'haang4', '更': 'gaang1', // Polyphonic characters
      '你': 'nei5', '好': 'hou2', '我': 'ngo5', '係': 'hai6',
      '有': 'jau5', '冇': 'mou5', '去': 'heoi3', '嚟': 'lai4',
      '食': 'sik6', '飲': 'jam2', '睇': 'tai2', '聽': 'teng1',
      '講': 'gong2', '話': 'waa6', '知': 'zi1', '道': 'dou6',
      '做': 'zou6', '買': 'maai5', '賣': 'maai6', '錢': 'cin4',
      '屋': 'uk1', '企': 'kei5', '坐': 'co5', '企': 'kei5',
      '走': 'zau2', '跑': 'paau2', '跳': 'tiu3', '游': 'jau4',
      '大': 'daai6', '細': 'sai3', '高': 'gou1', '矮': 'ai2',
      '長': 'coeng4', '短': 'dyun2', '肥': 'fei4', '瘦': 'sau3',
      '新': 'san1', '舊': 'gau6', '靚': 'leng3', '醜': 'cau2',
      '快': 'faai3', '慢': 'maan6', '早': 'zou2', '遲': 'ci4',
      '熱': 'jit6', '凍': 'dung3', '暖': 'nyun5', '涼': 'loeng4'
    };
    
    const result = [];
    for (const char of text) {
      if (jyutpingMap[char]) {
        result.push(jyutpingMap[char]);
      } else if (/[\u4e00-\u9fff]/.test(char)) {
        // For unknown Chinese characters, use a fallback
        result.push('?');
      } else {
        // Keep non-Chinese characters as-is
        result.push(char);
      }
    }
    
    return result;
  }

  generateSpans(originalText, romanizedText, script) {
    // Generate spans for alignment
    return [{
      range: [0, originalText.length],
      script: script,
      romanized: romanizedText
    }];
  }
}
