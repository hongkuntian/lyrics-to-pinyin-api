import { pinyin } from "pinyin-pro";
import { BaseProcessor } from "./base.js";

export class ChineseProcessor extends BaseProcessor {
  constructor() {
    super("ChineseProcessor", ["pinyin"]);
  }

  async romanize(text, system = "pinyin", options = {}) {
    const {
      tone_style = "marks", // marks, numbers, none
      separator = " ",
      case: caseOption = "lower",
      normalize_variants = true
    } = options;

    let romanized;
    let confidence = 0.95;
    let spans = [];

    try {
      // Normalize traditional/simplified variants if requested
      let normalizedText = text;
      if (normalize_variants) {
        normalizedText = this.normalizeVariants(text);
      }

      // Convert to pinyin based on tone style
      romanized = this.toPinyin(normalizedText, { 
        tone_style, 
        separator, 
        case: caseOption 
      });

      // Generate spans for alignment (future expansion)
      spans = this.generateSpans(text, romanized, "zh");

      return {
        romanized,
        system,
        confidence,
        spans
      };
    } catch (error) {
      console.error("Chinese romanization error:", error);
      throw new Error(`Failed to romanize Chinese text: ${error.message}`);
    }
  }

  toPinyin(text, options) {
    const { tone_style, separator, case: caseOption } = options;
    
    let toneType;
    switch (tone_style) {
      case "marks":
        toneType = "symbol";
        break;
      case "numbers":
        toneType = "num";
        break;
      case "none":
        toneType = "none";
        break;
      default:
        toneType = "symbol";
    }
    
    let result = pinyin(text, { toneType, type: "array" });
    result = result.join(separator);
    
    // Apply case
    if (caseOption === "title") {
      result = result.replace(/\b\w/g, l => l.toUpperCase());
    } else if (caseOption === "upper") {
      result = result.toUpperCase();
    }
    
    return result;
  }

  normalizeVariants(text) {
    // Simple traditional to simplified conversion
    // In production, you'd use chinese-conv or opencc library
    const traditionalToSimplified = {
      '繁體': '繁体', '簡體': '简体', '台灣': '台湾',
      '香港': '香港', '澳門': '澳门', '中國': '中国'
    };
    
    let normalized = text;
    for (const [traditional, simplified] of Object.entries(traditionalToSimplified)) {
      normalized = normalized.replace(new RegExp(traditional, 'g'), simplified);
    }
    
    return normalized;
  }

  generateSpans(originalText, romanizedText, script) {
    // Generate spans for alignment (simplified implementation)
    // In production, this would provide character-by-character alignment
    return [{
      range: [0, originalText.length],
      script: script,
      romanized: romanizedText
    }];
  }
}
