import { BaseProcessor } from "./base.js";

export class JapaneseProcessor extends BaseProcessor {
  constructor() {
    super("JapaneseProcessor", ["hepburn"]);
  }

  async romanize(text, system = "hepburn", options = {}) {
    const {
      separator = " ",
      case: caseOption = "lower",
      long_vowels = "macron" // macron, circumflex, or double
    } = options;

    let romanized;
    let confidence = 0.90;
    let spans = [];

    try {
      // Convert to Hepburn romaji
      romanized = this.toHepburn(text, { separator, case: caseOption, long_vowels });

      // Generate spans for alignment
      spans = this.generateSpans(text, romanized, "ja");

      return {
        romanized,
        system,
        confidence,
        spans
      };
    } catch (error) {
      console.error("Japanese romanization error:", error);
      throw new Error(`Failed to romanize Japanese text: ${error.message}`);
    }
  }

  toHepburn(text, options) {
    const { separator, case: caseOption, long_vowels } = options;
    
    // This is a simplified implementation
    // In production, you'd use kuroshiro + kuromoji libraries
    let result = this.basicRomajiConversion(text);
    
    // Apply Hepburn-specific rules
    result = result
      .replace(/si/g, "shi")
      .replace(/ti/g, "chi")
      .replace(/tu/g, "tsu")
      .replace(/hu/g, "fu")
      .replace(/zi/g, "ji")
      .replace(/di/g, "ji")
      .replace(/du/g, "zu");
    
    // Handle long vowels
    result = this.handleLongVowels(result, long_vowels);
    
    // Apply case
    if (caseOption === "title") {
      result = result.replace(/\b\w/g, l => l.toUpperCase());
    } else if (caseOption === "upper") {
      result = result.toUpperCase();
    }
    
    return result;
  }

  basicRomajiConversion(text) {
    // This is a placeholder for basic kana to romaji conversion
    // In production, you'd use kuroshiro + kuromoji
    return text
      // Basic vowels
      .replace(/あ/g, "a").replace(/い/g, "i").replace(/う/g, "u").replace(/え/g, "e").replace(/お/g, "o")
      // Basic consonants
      .replace(/か/g, "ka").replace(/き/g, "ki").replace(/く/g, "ku").replace(/け/g, "ke").replace(/こ/g, "ko")
      .replace(/さ/g, "sa").replace(/し/g, "shi").replace(/す/g, "su").replace(/せ/g, "se").replace(/そ/g, "so")
      .replace(/た/g, "ta").replace(/ち/g, "chi").replace(/つ/g, "tsu").replace(/て/g, "te").replace(/と/g, "to")
      .replace(/な/g, "na").replace(/に/g, "ni").replace(/ぬ/g, "nu").replace(/ね/g, "ne").replace(/の/g, "no")
      .replace(/は/g, "ha").replace(/ひ/g, "hi").replace(/ふ/g, "fu").replace(/へ/g, "he").replace(/ほ/g, "ho")
      .replace(/ま/g, "ma").replace(/み/g, "mi").replace(/む/g, "mu").replace(/め/g, "me").replace(/も/g, "mo")
      .replace(/や/g, "ya").replace(/ゆ/g, "yu").replace(/よ/g, "yo")
      .replace(/ら/g, "ra").replace(/り/g, "ri").replace(/る/g, "ru").replace(/れ/g, "re").replace(/ろ/g, "ro")
      .replace(/わ/g, "wa").replace(/を/g, "wo")
      .replace(/ん/g, "n")
      // Katakana
      .replace(/ア/g, "a").replace(/イ/g, "i").replace(/ウ/g, "u").replace(/エ/g, "e").replace(/オ/g, "o")
      .replace(/カ/g, "ka").replace(/キ/g, "ki").replace(/ク/g, "ku").replace(/ケ/g, "ke").replace(/コ/g, "ko")
      .replace(/サ/g, "sa").replace(/シ/g, "shi").replace(/ス/g, "su").replace(/セ/g, "se").replace(/ソ/g, "so")
      .replace(/タ/g, "ta").replace(/チ/g, "chi").replace(/ツ/g, "tsu").replace(/テ/g, "te").replace(/ト/g, "to")
      .replace(/ナ/g, "na").replace(/ニ/g, "ni").replace(/ヌ/g, "nu").replace(/ネ/g, "ne").replace(/ノ/g, "no")
      .replace(/ハ/g, "ha").replace(/ヒ/g, "hi").replace(/フ/g, "fu").replace(/ヘ/g, "he").replace(/ホ/g, "ho")
      .replace(/マ/g, "ma").replace(/ミ/g, "mi").replace(/ム/g, "mu").replace(/メ/g, "me").replace(/モ/g, "mo")
      .replace(/ヤ/g, "ya").replace(/ユ/g, "yu").replace(/ヨ/g, "yo")
      .replace(/ラ/g, "ra").replace(/リ/g, "ri").replace(/ル/g, "ru").replace(/レ/g, "re").replace(/ロ/g, "ro")
      .replace(/ワ/g, "wa").replace(/ヲ/g, "wo")
      .replace(/ン/g, "n");
  }

  handleLongVowels(text, long_vowels) {
    switch (long_vowels) {
      case "macron":
        return text
          .replace(/aa/g, "ā").replace(/ii/g, "ī").replace(/uu/g, "ū").replace(/ee/g, "ē").replace(/oo/g, "ō");
      case "circumflex":
        return text
          .replace(/aa/g, "â").replace(/ii/g, "î").replace(/uu/g, "û").replace(/ee/g, "ê").replace(/oo/g, "ô");
      case "double":
      default:
        return text; // Keep as double vowels
    }
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
