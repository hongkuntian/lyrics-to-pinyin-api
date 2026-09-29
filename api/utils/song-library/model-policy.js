export const MODEL='gpt-6-luna';
export const LEGACY_MODEL='gpt-5.6-luna';
export const SUPPORTED_MODELS=[MODEL,LEGACY_MODEL];
// USD per million tokens, equivalently microdollars per token. Use cache-write
// input prices conservatively. Existing admitted work retains its original rates.
// GPT-6 rates verified 2026-09-29: https://developers.openai.com/api/docs/models/gpt-6-luna
const policies={
  [MODEL]:{effort:'xhigh',input:0.125,output:0.5},
  [LEGACY_MODEL]:{effort:'high',input:0.25,output:1.2}
};
export const modelPolicy=model=>Object.hasOwn(policies,model)?policies[model]:null;
