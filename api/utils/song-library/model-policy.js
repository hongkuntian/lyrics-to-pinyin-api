export const MODEL='gpt-6-luna';
export const RESEARCH_MODEL='gpt-6.1-sol';
// Public price only: no account entitlement or scientific qualification.
export const RESEARCH_BATCH_PRICE=Object.freeze({version:'sol-batch-price-20261022',model:RESEARCH_MODEL,input:1.25,output:5,sourceReceiptSHA256:'067c250e2b39e217b4201f150ecde51978a9b6d7e2c9365276bb22e05c557bc3'});
export const LEGACY_MODEL='gpt-5.6-luna';
export const SUPPORTED_MODELS=[MODEL,LEGACY_MODEL];
// USD per million tokens, equivalently microdollars per token. Use cache-write
// input prices conservatively. Existing admitted work retains its original rates.
// GPT-6 rates verified 2026-09-29: https://developers.openai.com/api/docs/models/gpt-6-luna
const policies={
  [MODEL]:{effort:'xhigh',input:0.125,output:0.5},
  // Optional server-only research body; Standard 30m cache-write upper rate.
  // Root verified official pricing 2026-10-22; entitlement is not implied.
  [RESEARCH_MODEL]:{effort:'xhigh',input:2.5,output:10},
  [LEGACY_MODEL]:{effort:'high',input:0.25,output:1.2}
};
export const modelPolicy=model=>Object.hasOwn(policies,model)?policies[model]:null;
