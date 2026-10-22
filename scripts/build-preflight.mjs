import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

const allowed=/^(?:library_(?:schema_ready|migrations_applied|sources_migrated|translations_repaired|build_failed)|content_quality_chunk|multilingual_evaluation_(?:start|chunk|failure|complete)|language_expansion_[a-z_]+)$/;
const failure=(code,details={})=>Object.assign(new Error(code),{code,...details});

// Stream only the reviewed child's structured protocol. Earlier settled records
// survive a later failure; there is no buffered execFile result to lose or overflow.
// Cross-build submission authority belongs to the frozen external evaluation ledger.
export function runBuildPreflight({executable=process.execPath,args,cwd,env=process.env,
 emit=event=>console.log(JSON.stringify(event)),spawnFn=spawn,maxRecordBytes=16384,maxOutputBytes=16*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const child=spawnFn(executable,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  let invalid=null,total=0;
  const streams=[child.stdout,child.stderr].map(stream=>({stream,decoder:new StringDecoder('utf8'),pending:''}));
  const stop=()=>{invalid??=failure('build_preflight_output_invalid');child.kill('SIGTERM');};
  function record(text){
   if(invalid||!text.trim())return;
   if(Buffer.byteLength(text)>maxRecordBytes){stop();return;}
   let value;try{value=JSON.parse(text);}catch{return;}
   if(value&&typeof value==='object'&&!Array.isArray(value)&&allowed.test(value.event)){
    try{emit(value);}catch{stop();}
   }
  }
  function receive(state,data){
   total+=data.length;if(total>maxOutputBytes){stop();return;}
   state.pending+=state.decoder.write(data);
   let end;
   while((end=state.pending.indexOf('\n'))>=0){record(state.pending.slice(0,end));state.pending=state.pending.slice(end+1);}
   if(Buffer.byteLength(state.pending)>maxRecordBytes)stop();
  }
  for(const state of streams)state.stream.on('data',data=>receive(state,data));
  child.on('error',()=>reject(failure('build_preflight_unavailable')));
  child.on('close',(code,signal)=>{
   for(const state of streams){state.pending+=state.decoder.end();record(state.pending);}
   if(invalid)reject(invalid);
   else if(code!==0)reject(failure('build_preflight_failed',{exitCode:code,signal}));
   else resolve();
  });
 });
}
