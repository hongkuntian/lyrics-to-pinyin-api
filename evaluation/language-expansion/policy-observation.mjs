// Evaluation-only: observe two noncredential direction arrays. Never serves traffic.
// The exact deployed policy module executes in an IO-free VM with explicit env.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const sourceSHA256='8aa53b72471f877aafba100871c51904c3927e72dd550ea2d26a032963eae3d9';
export const probeID='language-effective-policy-observation-20261022-r1';
export function observePolicy(source,environment={}) {
  if(sha(source)!==sourceSHA256)throw new Error('policy_source_pin_mismatch');
  const scoped={};const inputs={};
  for(const key of ['LYRA_TRANSLATION_DIRECTIONS','LYRA_EXPLANATION_DIRECTIONS']) {
    const value=environment[key];
    if(value!==undefined&&(typeof value!=='string'||Buffer.byteLength(value)>8192))throw new Error('policy_input_bound');
    if(value!==undefined)scoped[key]=value;
    inputs[key]={present:value!==undefined,sha256:value===undefined?null:sha(value)};
  }
  // These exact textual removals are protected by the entire source-file hash.
  const stripped=source.toString().replace("import {LibraryError} from './store.js';\n",'').replace(/^export /gm,'');
  if(/\bimport\b/.test(stripped))throw new Error('unexpected_policy_import');
  const context=vm.createContext({LibraryError:class LibraryError extends Error {
    constructor(code,status=409){super(code);this.code=code;this.status=status;}
  },scoped});
  const policy=new vm.Script(stripped+'\nJSON.parse(JSON.stringify({policy:environmentLanguagePolicy(scoped),capabilities:capabilities(environmentLanguagePolicy(scoped))}))').runInContext(context,{timeout:1000});
  const result=JSON.parse(JSON.stringify(policy));
  if(Buffer.byteLength(JSON.stringify(result))>16000)throw new Error('policy_output_bound');
  return {sourceSHA256,inputs,...result};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const sourcePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../api/utils/song-library/languages.js');
    const observation=observePolicy(await fs.readFile(sourcePath),{
      LYRA_TRANSLATION_DIRECTIONS:process.env.LYRA_TRANSLATION_DIRECTIONS,
      LYRA_EXPLANATION_DIRECTIONS:process.env.LYRA_EXPLANATION_DIRECTIONS
    });
    const gitSHA=process.env.VERCEL_GIT_COMMIT_SHA;
    if(typeof gitSHA!=='string'||!/^([a-f0-9]{40})$/.test(gitSHA)||process.env.VERCEL_ENV!=='production')throw new Error('invalid_probe_context');
    process.stdout.write(JSON.stringify({event:'language_policy_observation',probeID,version:1,gitSHA,target:'production',node:process.version,observation})+'\n');
  } catch {process.stdout.write(JSON.stringify({event:'language_policy_observation_failure',probeID,version:1})+'\n');}
  // Fail before packaging: no serving deployment or alias can result.
  process.exitCode=1;
}
