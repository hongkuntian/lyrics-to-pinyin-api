import {BaseProcessor} from './base.js';
import {analyzeReading,renderReading} from '../utils/pronunciation-aids.js';

export class KoreanProcessor extends BaseProcessor {
  constructor(){super('KoreanProcessor',['revised']);}
  async romanize(text,system='revised',options={}){
    const reading=await analyzeReading(text,'ko');
    let romanized=renderReading(reading,'ko-revised').text;
    if(options.case==='upper')romanized=romanized.toUpperCase();
    if(options.case==='title')romanized=romanized.replace(/\b\p{L}/gu,c=>c.toUpperCase());
    // Legacy confidence is a coverage indicator, not a calibrated correctness score.
    const pronounced=reading.segments.filter(s=>s.status!=='verbatim');
    const confidence=pronounced.length?pronounced.filter(s=>s.status==='resolved').length/pronounced.length:0;
    return {romanized,system,confidence,spans:[{range:[0,text.length],script:'ko',romanized}]};
  }
}
