import {BaseProcessor} from './base.js';
import {analyzeReading,renderReading} from '../utils/pronunciation-aids.js';

export class JapaneseProcessor extends BaseProcessor {
  constructor(){super('JapaneseProcessor',['hepburn']);}
  async romanize(text,system='hepburn',options={}){
    const reading=await analyzeReading(text,'ja');
    let romanized=renderReading(reading,'ja-hepburn').text;
    if(options.long_vowels==='double')romanized=romanized.replace(/[āīūēō]/g,c=>({ā:'aa',ī:'ii',ū:'uu',ē:'ee',ō:'oo'})[c]);
    if(options.long_vowels==='circumflex')romanized=romanized.replace(/[āīūēō]/g,c=>({ā:'â',ī:'î',ū:'û',ē:'ê',ō:'ô'})[c]);
    if(options.case==='upper')romanized=romanized.toUpperCase();
    if(options.case==='title')romanized=romanized.replace(/\b\p{L}/gu,c=>c.toUpperCase());
    // Legacy confidence is a coverage indicator, not a calibrated correctness score.
    const pronounced=reading.segments.filter(s=>s.status!=='verbatim');
    const confidence=pronounced.length?pronounced.filter(s=>s.status==='resolved').length/pronounced.length:0;
    return {romanized,system,confidence,spans:[{range:[0,text.length],script:'ja',romanized}]};
  }
}
