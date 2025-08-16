import { ChineseProcessor } from "./chinese.js";
import { CantoneseProcessor } from "./cantonese.js";
import { JapaneseProcessor } from "./japanese.js";
import { KoreanProcessor } from "./korean.js";
import { RussianProcessor } from "./russian.js";

// Processor registry - MVP with five core languages
const processors = new Map();

// Initialize processors with script-based codes
processors.set("zh", new ChineseProcessor());   // Mandarin Chinese
processors.set("yue", new CantoneseProcessor()); // Cantonese
processors.set("ja", new JapaneseProcessor());   // Japanese
processors.set("ko", new KoreanProcessor());     // Korean
processors.set("ru", new RussianProcessor());    // Russian

export function getProcessor(scriptCode) {
  return processors.get(scriptCode);
}

export function getSupportedLanguages() {
  return Array.from(processors.keys());
}

export function registerProcessor(scriptCode, processor) {
  processors.set(scriptCode, processor);
}
