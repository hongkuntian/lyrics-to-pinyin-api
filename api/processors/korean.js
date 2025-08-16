import { BaseProcessor } from "./base.js";

export class KoreanProcessor extends BaseProcessor {
  constructor() {
    super("KoreanProcessor", ["revised"]);
  }

  async romanize(text, system = "revised", options = {}) {
    const {
      separator = " ",
      case: caseOption = "lower"
    } = options;

    let romanized;
    let confidence = 0.90;
    let spans = [];

    try {
      // Convert to Revised Romanization
      romanized = this.toRevised(text, { separator, case: caseOption });

      // Generate spans for alignment
      spans = this.generateSpans(text, romanized, "ko");

      return {
        romanized,
        system,
        confidence,
        spans
      };
    } catch (error) {
      console.error("Korean romanization error:", error);
      throw new Error(`Failed to romanize Korean text: ${error.message}`);
    }
  }

  toRevised(text, options) {
    const { separator, case: caseOption } = options;
    
    // This is a simplified implementation
    // In production, you'd use hangul-romanization or korean-romanizer library
    let result = this.basicKoreanConversion(text);
    
    // Apply Revised Romanization rules
    result = result
      .replace(/ch'/g, "ch")
      .replace(/k'/g, "k")
      .replace(/p'/g, "p")
      .replace(/t'/g, "t");
    
    // Apply case
    if (caseOption === "title") {
      result = result.replace(/\b\w/g, l => l.toUpperCase());
    } else if (caseOption === "upper") {
      result = result.toUpperCase();
    }
    
    return result;
  }

  basicKoreanConversion(text) {
    // This is a placeholder for basic Hangul to romanization conversion
    // In production, you'd use a proper library
    return text
      // Basic vowels
      .replace(/아/g, "a").replace(/어/g, "eo").replace(/오/g, "o").replace(/우/g, "u").replace(/으/g, "eu").replace(/이/g, "i")
      // Basic consonants
      .replace(/ㄱ/g, "g").replace(/ㄴ/g, "n").replace(/ㄷ/g, "d").replace(/ㄹ/g, "r").replace(/ㅁ/g, "m")
      .replace(/ㅂ/g, "b").replace(/ㅅ/g, "s").replace(/ㅇ/g, "ng").replace(/ㅈ/g, "j").replace(/ㅊ/g, "ch")
      .replace(/ㅋ/g, "k").replace(/ㅌ/g, "t").replace(/ㅍ/g, "p").replace(/ㅎ/g, "h")
      // Combined characters (simplified)
      .replace(/가/g, "ga").replace(/나/g, "na").replace(/다/g, "da").replace(/라/g, "ra").replace(/마/g, "ma")
      .replace(/바/g, "ba").replace(/사/g, "sa").replace(/아/g, "a").replace(/자/g, "ja").replace(/차/g, "cha")
      .replace(/카/g, "ka").replace(/타/g, "ta").replace(/파/g, "pa").replace(/하/g, "ha")
      // Special cases for 받침 assimilation
      .replace(/국물/g, "gukmul") // Example of 받침 assimilation
      .replace(/한국/g, "hanguk")
      .replace(/안녕/g, "annyeong")
      .replace(/감사/g, "gamsa")
      .replace(/한국어/g, "hangugeo");
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
