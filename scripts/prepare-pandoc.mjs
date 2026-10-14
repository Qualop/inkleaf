import {readFile,mkdir,mkdtemp,rm,readdir,copyFile,chmod,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(import.meta.dirname,'..');
const provenance=JSON.parse(await readFile(path.join(root,'tools/pandoc-provenance.json'),'utf8'));
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('The pinned macOS Pandoc binary is for Apple Silicon. Configure a local Pandoc path on other platforms.');
const destination=path.join(root,'tools/pandoc');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  if(sha(await readFile(destination))===provenance.binary_sha256){process.stdout.write(`Pandoc ${provenance.version} already verified.\n`);process.exit(0);}
}catch(error){if(error.code!=='ENOENT')throw error;}
const temporary=await mkdtemp(path.join(os.tmpdir(),'inkleaf-pandoc-'));
try{
  const response=await fetch(provenance.official_url);
  if(!response.ok)throw new Error(`Pandoc download failed: ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  if(sha(bytes)!==provenance.archive_sha256)throw new Error('Pandoc archive checksum mismatch.');
  const archive=path.join(temporary,'pandoc.zip'),unpacked=path.join(temporary,'unpacked');
  await writeFile(archive,bytes);await mkdir(unpacked);
  await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/ditto',['-x','-k',archive,unpacked],{stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`ditto exited ${code}`)));});
  async function locate(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const name=path.join(directory,entry.name);if(entry.isFile()&&entry.name==='pandoc')return name;if(entry.isDirectory()){const found=await locate(name);if(found)return found;}}}
  const executable=await locate(unpacked);
  if(!executable||sha(await readFile(executable))!==provenance.binary_sha256)throw new Error('Pandoc binary checksum mismatch.');
  await copyFile(executable,destination);await chmod(destination,0o755);
  process.stdout.write(`Prepared verified Pandoc ${provenance.version}.\n`);
}finally{await rm(temporary,{recursive:true,force:true});}
