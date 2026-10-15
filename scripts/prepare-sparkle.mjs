import {mkdir,readFile,writeFile,rename,rm,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';

export const sparkleVersion='2.10.0';
export const toolsHash='c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c';
export const sparkleAccount='dev.inkleaf.editor.updates';
const root=path.resolve(import.meta.dirname,'..');
export const toolsDirectory=path.join(root,'.cache',`sparkle-${sparkleVersion}`);
export async function run(command,args,{capture=false}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:root,stdio:capture?['ignore','pipe','pipe']:'inherit'});let output='',diagnostics='';
  if(capture){child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>diagnostics+=bytes);}
  child.once('error',reject);child.once('exit',code=>code===0?resolve(output.trim()):reject(new Error(`${path.basename(command)} failed (${code}): ${diagnostics.trim()}`)));
 });
}
export async function prepareSparkle(){
 const archive=path.join(root,'.cache',`Sparkle-${sparkleVersion}.tar.xz`);
 await mkdir(path.dirname(archive),{recursive:true});
 let valid=false;try{valid=createHash('sha256').update(await readFile(archive)).digest('hex')===toolsHash;}catch{}
 if(!valid){
  const temporary=archive+'.download';
  try{
   const response=await fetch(`https://github.com/sparkle-project/Sparkle/releases/download/${sparkleVersion}/Sparkle-${sparkleVersion}.tar.xz`,{signal:AbortSignal.timeout(120000)});
   if(!response.ok)throw new Error(`Sparkle download failed: HTTP ${response.status}`);
   const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==toolsHash)throw new Error('Sparkle archive checksum mismatch.');
   await writeFile(temporary,bytes);await rename(temporary,archive);
  }finally{await rm(temporary,{force:true});}
 }
 // Re-extract the verified archive; do not trust executables merely because they are cached.
 await rm(toolsDirectory,{recursive:true,force:true});await mkdir(toolsDirectory,{recursive:true});
 await run('/usr/bin/tar',['-xJf',archive,'-C',toolsDirectory]);
 for(const tool of ['generate_keys','sign_update','generate_appcast'])await access(path.join(toolsDirectory,'bin',tool));
 return toolsDirectory;
}
if(process.argv[1]===import.meta.filename){await prepareSparkle();console.log(`Verified Sparkle ${sparkleVersion} tools ready.`);}
