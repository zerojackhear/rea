import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {arm64ImageOracle,rustOracle} from './artifact-oracle.mjs';

const EXPECTED_HEAD='c19c2d6723fb92548b0c8a1ed0696d721a80aae6';
const EXPECTED_TREE='d6405587116af64c4d9bac2216525dc68cc262fc';
const opts={};
for(let i=2;i<process.argv.length;i+=2){
 const key=process.argv[i],value=process.argv[i+1];
 assert.ok(['--root','--artifacts-dir','--out','--bootstrap-receipt'].includes(key) && value && !opts[key], 'Expected unique --root ROOT --artifacts-dir DIR --out DIR --bootstrap-receipt FILE');
 opts[key]=value;
}
for(const key of ['--root','--artifacts-dir','--out','--bootstrap-receipt'])assert.ok(opts[key],key+' required');
const ROOT=resolve(opts['--root']),ARTIFACTS=resolve(opts['--artifacts-dir']),OUT=resolve(opts['--out']),BOOTSTRAP=resolve(opts['--bootstrap-receipt']);
assert.notEqual(OUT,ARTIFACTS,'Keep capture output separate from input artifacts');
await mkdir(OUT,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=async(name,value)=>writeFile(join(OUT,name),JSON.stringify(value,null,2)+'\n');
const boundedRead=async path=>{assert.ok(isAbsolute(path));const s=await stat(path);assert.ok(s.isFile()&&s.size>0&&s.size<=256*1024*1024,'Bounded regular artifact required');return readFile(path);};
const deadline=async(promise,ms,label)=>{
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' deadline exceeded')),ms);})]);}finally{clearTimeout(timer);}
};
const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8',timeout:15000,maxBuffer:1024*1024}).trim();
const entrypoint=join(ROOT,'scripts','rea.mjs');
const receipt={status:'running',started_at:new Date().toISOString(),expected_source_head:EXPECTED_HEAD,expected_source_tree:EXPECTED_TREE,root:ROOT,artifacts_dir:ARTIFACTS,node:{version:process.version,executable:process.execPath,process_arch:process.arch,platform:process.platform},successful_static_inspections:0,target_executions:0,verified:[],limitations:['Only these two newly built print-and-exit fixtures and their exact three-package Rust closure are covered.','Embedded metadata is observed file content; a /rustc/<hash>/ string remains inferred compiler identity, even when it matches the separately recorded toolchain.','Native OS architecture is independently supplied by bootstrap and is distinct from Node process architecture; an x64 Node on Windows ARM64 does not turn an ARM64 PE target into x64.','Direct child exit and stdio close are observed. No general process-family ownership, CPU/RSS/token measurement, broader ABI support, or performance comparison is claimed.']};
let client,transport,mcpClosed=false,mcpStderrBytes=0,mcpStderrOverflow=false;
const stderrChunks=[];
const sourceSnapshots=[];
const artifactSnapshots=[];
async function runCaptured(command,args,key,timeoutMs,maxBytes=8*1024*1024){
 const started=performance.now(),stdout=[],stderr=[];let total=0,timedOut=false,overflow=false,spawnError=null,killError=null,settled=false;
 const child=spawn(command,args,{cwd:ROOT,env:{...process.env,REA_LOG_LEVEL:'silent'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let timer;
 const kill=()=>{try{assert.equal(child.kill('SIGKILL'),true,'Direct child kill was not accepted');}catch(e){killError=String(e);}};
 const capture=chunks=>chunk=>{total+=chunk.length;if(total>maxBytes){if(!overflow){overflow=true;kill();}return;}chunks.push(Buffer.from(chunk));};
 child.stdout.on('data',capture(stdout));child.stderr.on('data',capture(stderr));child.on('error',e=>{spawnError={name:e.name,message:e.message,code:e.code};});
 const completed=new Promise(done=>child.once('close',(code,signal)=>{settled=true;clearTimeout(timer);done({code,signal});}));
 timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
 let result={code:null,signal:null},completionError=null;
 try{result=await deadline(completed,timeoutMs+5000,key+' child close');}catch(error){completionError=String(error);}
 finally{clearTimeout(timer);if(!settled){kill();child.stdout.destroy();child.stderr.destroy();}}
 const out=Buffer.concat(stdout),err=Buffer.concat(stderr);
 await writeFile(join(OUT,key+'.stdout.log'),out);await writeFile(join(OUT,key+'.stderr.log'),err);
 const record={command:[command,...args],cwd:ROOT,timeout_ms:timeoutMs,timed_out:timedOut,output_overflow:overflow,output_budget_bytes:maxBytes,stdout_bytes:out.length,stderr_bytes:err.length,stdout_file:join(OUT,key+'.stdout.log'),stderr_file:join(OUT,key+'.stderr.log'),exit_code:result.code,signal:result.signal,spawn_error:spawnError,completion_error:completionError,kill_error:killError,close_observed:settled,elapsed_ms:performance.now()-started};
 await save(key+'.process.json',record);
 return {record,stdout:out,stderr:err};
}
function requireGoodProcess(run,label){
 assert.equal(run.record.spawn_error,null,label+' spawn error');assert.equal(run.record.completion_error,null,label+' child close error');assert.equal(run.record.timed_out,false,label+' timed out');assert.equal(run.record.output_overflow,false,label+' capture overflow');assert.equal(run.record.kill_error,null,label+' cleanup failure');assert.equal(run.record.exit_code,0,label+' nonzero exit');assert.equal(run.record.signal,null,label+' signal exit');assert.equal(run.record.close_observed,true);
}
async function runtimeSnapshots(){
 for(const relative of ['scripts/rea.mjs','src/go/GoBinaryProvider.ts','src/go/GoBinaryImage.ts','src/rust/RustBinaryProvider.ts','src/rust/RustBinaryImage.ts','src/rust/RustAuditableReader.ts','src/native/metadata/ElfImage.ts','src/native/metadata/PeImage.ts','dist/domain/evidence.js','dist/domain/go/goBinary.js','dist/domain/rust/rustBinary.js','dist/go/GoBinaryImage.js','dist/rust/RustBinaryImage.js','dist/native/metadata/ElfImage.js','dist/native/metadata/PeImage.js','dist/mcp/main.js']){
  const path=join(ROOT,relative);sourceSnapshots.push({path:relative,sha256:sha(await readFile(path))});
 }
 receipt.runtime_sources=sourceSnapshots;
}
async function checkInput(path,before){
 const after=await boundedRead(path);assert.deepEqual(after,before,'Artifact bytes changed');
 return {path,sha256:sha(after),bytes:after.length,unchanged:true};
}
try{
 const bootstrapBytes=await boundedRead(BOOTSTRAP),bootstrap=JSON.parse(bootstrapBytes.toString('utf8').replace(/^\uFEFF/,''));
 receipt.bootstrap={path:BOOTSTRAP,sha256:sha(bootstrapBytes),receipt:bootstrap};
 assert.equal(bootstrap.status,'passed');assert.equal(bootstrap.source_head,EXPECTED_HEAD);assert.equal(bootstrap.source_tree,EXPECTED_TREE);
 assert.ok(['linux','windows'].includes(bootstrap.native_os));assert.equal(bootstrap.native_arch,'arm64');
 assert.equal(process.platform,bootstrap.native_os==='windows'?'win32':'linux');
 assert.match(bootstrap.go_version,/^go1\.\d+\.\d+(?:[a-z0-9.-]*)?$/);
 assert.match(bootstrap.rustc_commit,/^[0-9a-f]{40}$/);
 assert.equal(bootstrap.rust_target,bootstrap.native_os==='windows'?'aarch64-pc-windows-msvc':'aarch64-unknown-linux-gnu');
 assert.ok(bootstrap.toolchains && typeof bootstrap.toolchains==='object','Bootstrap toolchain versions and digests required');
 assert.ok(bootstrap.builds?.go && bootstrap.builds?.rust,'Bootstrap must record both build commands');
 receipt.source_head=git('rev-parse','HEAD');receipt.source_tree=git('rev-parse','HEAD^{tree}');
 assert.equal(receipt.source_head,EXPECTED_HEAD,'Run built REA from the exact c19 runtime checkout');assert.equal(receipt.source_tree,EXPECTED_TREE);
 assert.equal(git('status','--porcelain','--untracked-files=no'),'','The exact c19 runtime checkout must have no tracked edits');
 await runtimeSnapshots();
 const require=createRequire(join(ROOT,'package.json'));
 const {Client}=require('@modelcontextprotocol/client'),{StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
 const {parseEvidence}=await import(pathToFileURL(join(ROOT,'dist/domain/evidence.js')).href);
 const {goBinarySchema}=await import(pathToFileURL(join(ROOT,'dist/domain/go/goBinary.js')).href);
 const {rustBinarySchema}=await import(pathToFileURL(join(ROOT,'dist/domain/rust/rustBinary.js')).href);
 client=new Client({name:'rea-c19-native-arm64-cloud-verifier',version:'1'});
 transport=new StdioClientTransport({command:process.execPath,args:[entrypoint,'mcp'],cwd:ROOT,env:{...process.env,REA_LOG_LEVEL:'silent'},stderr:'pipe',maxBufferSize:8*1024*1024});
 transport.stderr?.on('data',chunk=>{mcpStderrBytes+=chunk.length;if(mcpStderrBytes>1024*1024){mcpStderrOverflow=true;return;}stderrChunks.push(Buffer.from(chunk));});
 await deadline(client.connect(transport),45000,'MCP connect');
 const originalOnclose=transport.onclose;transport.onclose=()=>{mcpClosed=true;originalOnclose?.();};
 const suffix=bootstrap.native_os==='windows'?'.exe':'';
 for(const kind of ['go','rust']){
  receipt.active_case=kind;const path=join(ARTIFACTS,kind+'-fixture'+suffix),before=await boundedRead(path),hash=sha(before);
  assert.equal(bootstrap.builds[kind].artifact_sha256,hash,'Artifact differs from bootstrap build output');
  artifactSnapshots.push({path,sha256:hash,bytes:before.length});
  const image=arm64ImageOracle(before),format=bootstrap.native_os==='windows'?'pe':'elf';
  assert.equal(image.format,format);
  const oracle=kind==='rust'?rustOracle(before,image):null;
  if(oracle?.rustc_commit)assert.ok(oracle.rustc_commit.hashes.some(x=>x.hash===bootstrap.rustc_commit),'Expected toolchain hash is absent from readonly paths');
  await save(kind+'-independent-oracle.json',{format:image.format,machine:image.machine,architecture:image.architecture,bits:image.bits,sections:image.sections,...(oracle??{})});
  const evidences=[];
  for(const mode of ['cli','mcp']){
   receipt.active_mode=mode;let raw;
   if(mode==='cli'){
    const run=await runCaptured(process.execPath,[entrypoint,'inspect-'+kind+'-binary',path,'--json'],kind+'-cli',45000);
    requireGoodProcess(run,kind+' CLI');raw=JSON.parse(run.stdout.toString('utf8'));
   }else{
    const response=await deadline(client.callTool({name:'inspect_'+kind+'_binary',arguments:{path}},{timeout:45000}),50000,kind+' MCP call');
    await save(kind+'-mcp-response.json',response);assert.notEqual(response.isError,true,'MCP tool returned isError');
    const texts=response.content?.filter(x=>x.type==='text');assert.equal(texts?.length,1,'Expected one evidence JSON text block');raw=JSON.parse(texts[0].text);assert.deepEqual(response.structuredContent,raw,'MCP structured output differs from text evidence');
   }
   const evidence=parseEvidence(raw),report=(kind==='go'?goBinarySchema:rustBinarySchema).parse(evidence.normalized_result);
   assert.equal(evidence.provider.id,kind==='go'?'go-build-info':'rust-auditable');assert.equal(evidence.operation,'inspect_'+kind+'_binary');assert.equal(evidence.confidence,'observed');assert.equal(evidence.authority,'shipped-artifact');
   assert.equal(evidence.subject.local_path,path);assert.equal(evidence.subject.digest.sha256,hash);assert.equal(evidence.subject.format,format);assert.equal(evidence.subject.architecture,'arm64');
   assert.deepEqual(report.artifact,{path,sha256:hash,bytes:before.length});assert.equal(report.format,format);assert.equal(report.architecture,'arm64');assert.equal(report.bits,64);assert.equal(report.byte_order,'little');
   if(kind==='go'){
    const info=report.build_info;assert.notEqual(info,null);assert.equal(info.go_version,bootstrap.go_version);
    assert.deepEqual(before.subarray(info.version_location.offset,info.version_location.offset+info.version_location.bytes),Buffer.from(info.go_version_bytes_base64,'base64'));
    assert.deepEqual(before.subarray(info.module_location.offset,info.module_location.offset+info.module_location.bytes),Buffer.from(info.module_bytes_base64,'base64'));
    assert.equal(info.module.path,'rea.example/arm64-cloud');assert.deepEqual(info.module.main,{path:'rea.example/arm64-cloud',version:'(devel)',sum:null,replacement:null});assert.deepEqual(info.module.dependencies,[]);
    assert.equal(info.module.complete,true);assert.deepEqual(info.module.unparsed_lines,[]);assert.deepEqual(info.module.unparsed_line_bytes_base64,[]);
    const settings=new Map(info.module.settings.map(x=>[x.key,x.value]));assert.equal(settings.get('GOOS'),bootstrap.native_os);assert.equal(settings.get('GOARCH'),'arm64');assert.equal(settings.get('CGO_ENABLED'),'0');
   }else{
    assert.deepEqual(report.auditable_metadata,oracle.metadata);assert.deepEqual(report.rustc_commit,oracle.rustc_commit);
    assert.ok(evidence.locations.some(x=>x.kind==='file-offset-range'&&x.start===oracle.section.offset&&x.end===oracle.section.offset+oracle.section.size));
    if(report.rustc_commit){assert.equal(report.rustc_commit.evidence_kind,'inferred');assert.ok(report.limitations.some(x=>x.includes('inferred')));}
    else assert.ok(report.limitations.some(x=>x.includes('unknown')),'Absent rustc path must remain explicitly unknown');
   }
   await save(kind+'-'+mode+'-evidence.json',evidence);evidences.push(evidence);receipt.successful_static_inspections++;
  }
  for(const field of ['normalized_result','subject','provider','confidence','authority','operation','parameters','limitations','locations'])assert.deepEqual(evidences[0][field],evidences[1][field],kind+' CLI/MCP '+field+' parity');
  const afterReads=await checkInput(path,before);
  const execution=await runCaptured(path,[],kind+'-runtime',15000,128*1024);receipt.target_executions++;
  execution.record.input_before={path,sha256:hash,bytes:before.length};
  execution.record.input_after=await checkInput(path,before);
  await save(kind+'-runtime.process.json',execution.record);
  requireGoodProcess(execution,kind+' print-and-exit runtime');
  const expected=kind==='go'?'rea-go-arm64-cloud os='+bootstrap.native_os+' arch=arm64\n':'rea-rust-arm64-cloud os='+bootstrap.native_os+' arch=aarch64 label=rea-fixture-42\n';
  assert.equal(execution.stdout.toString('utf8'),expected,'Unexpected runtime stdout');assert.equal(execution.stderr.length,0,'Unexpected runtime stderr');
  receipt.verified.push({kind,path,sha256:hash,bytes:before.length,format,architecture:'arm64',machine:image.machine,cli_mcp_parity:true,after_static_reads:afterReads,execution:execution.record,metadata:evidences[0].normalized_result});
 }
 assert.equal(receipt.successful_static_inspections,4);assert.equal(receipt.target_executions,2);
 assert.equal(mcpStderrOverflow,false,'MCP stderr overflow');
 await deadline(client.ping({timeout:15000}),20000,'MCP ping');receipt.mcp_responsive_after_reads=true;
 for(const item of artifactSnapshots){assert.equal(sha(await boundedRead(item.path)),item.sha256);}
 for(const item of sourceSnapshots)assert.equal(sha(await readFile(join(ROOT,item.path))),item.sha256,'Runtime source/build changed');
 assert.equal(sha(await readFile(BOOTSTRAP)),receipt.bootstrap.sha256,'Bootstrap receipt changed');
 assert.equal(git('rev-parse','HEAD'),EXPECTED_HEAD);assert.equal(git('rev-parse','HEAD^{tree}'),EXPECTED_TREE);assert.equal(git('status','--porcelain','--untracked-files=no'),'');
 receipt.inputs_unchanged=true;receipt.runtime_unchanged=true;receipt.status='passed';delete receipt.active_case;delete receipt.active_mode;
}catch(error){receipt.status='failed';receipt.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally{
 if(client||transport)try{
  await deadline((async()=>{await client?.close();await transport?.close();})(),10000,'MCP close');
  if(!mcpClosed)await deadline(new Promise(done=>{const started=performance.now();const poll=()=>{if(mcpClosed)done();else if(performance.now()-started>5000)done();else setTimeout(poll,50);};poll();}),5500,'MCP close observation');
  assert.equal(mcpClosed,true,'MCP child stdio close was not observed');receipt.stdio_closed=true;
 }catch(error){receipt.status='failed';receipt.cleanup_error=String(error);process.exitCode=1;}
 await writeFile(join(OUT,'mcp-stderr.log'),Buffer.concat(stderrChunks));receipt.mcp_stderr_bytes=mcpStderrBytes;receipt.mcp_stderr_overflow=mcpStderrOverflow;
 if(mcpStderrOverflow){receipt.status='failed';receipt.capture_error='MCP stderr exceeded 1 MiB capture budget';process.exitCode=1;}
 receipt.completed_at=new Date().toISOString();await save('receipt.json',receipt);
 console.log(JSON.stringify({status:receipt.status,receipt:join(OUT,'receipt.json'),successful_static_inspections:receipt.successful_static_inspections,target_executions:receipt.target_executions,error:receipt.error,cleanup_error:receipt.cleanup_error},null,2));
}
