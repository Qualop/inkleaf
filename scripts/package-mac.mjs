import {spawn} from 'node:child_process';
import {mkdir,rm,cp,symlink,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
if(process.platform!=='darwin')throw new Error('macOS is required to make the DMG and PKG.');
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const app=path.join(root,'build/Inkleaf.app');
const output=path.join(root,'dist');
const staging=path.join(root,'.cache/dmg-stage');
const stem=`Inkleaf-${version}-macOS-${process.arch}`;
function run(command,args){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:root,stdio:'inherit'});
  child.once('error',reject);
  child.once('exit',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
});}
if(!process.argv.includes('--skip-build'))await run(process.execPath,[path.join(root,'scripts/build.mjs')]);
await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
await mkdir(output,{recursive:true});
await rm(staging,{recursive:true,force:true});
await mkdir(staging,{recursive:true});
await cp(app,path.join(staging,'Inkleaf.app'),{recursive:true,preserveTimestamps:true});
await symlink('/Applications',path.join(staging,'Applications'));
await writeFile(path.join(staging,'Read Me.txt'),`Inkleaf ${version}\n\nDrag Inkleaf.app to Applications, or use the separate PKG installer.\nRequires macOS 14.5 or later; this build is for ${process.arch}.\n\nThis community build has a local ad-hoc code signature. It is not Developer ID signed or notarized. macOS may ask you to approve opening it in System Settings > Privacy & Security.\n\nApp icon: Settings > Appearance > App Icon. Black Ink is the default; Green Leaf is optional. The selection changes the running app's Dock/app-switcher icon. Finder and installers use Black Ink.\n\nLicense: MIT for Inkleaf source; see bundled component notices for third-party licenses.\n`);
await cp(path.join(root,'LICENSE'),path.join(staging,'LICENSE.txt'));
await run('/usr/bin/hdiutil',['create','-volname','Inkleaf','-srcfolder',staging,'-format','UDZO','-ov',path.join(output,`${stem}.dmg`)]);
await run('/usr/bin/pkgbuild',['--component',app,'--install-location','/Applications','--identifier','dev.inkleaf.editor.pkg','--version',version,'--ownership','recommended',path.join(output,`${stem}.pkg`)]);
const lines=[];
const files=[`${stem}.dmg`,`${stem}.pkg`];
const pandocSource='pandoc-3.12.1-source.tar.gz';
if(existsSync(path.join(output,pandocSource)))files.push(pandocSource);
for(const name of files){
  const digest=createHash('sha256').update(await readFile(path.join(output,name))).digest('hex');
  lines.push(`${digest}  ${name}`);
}
await writeFile(path.join(output,'SHA256SUMS.txt'),lines.join('\n')+'\n');
process.stdout.write(`Installers created in ${output}\n`);
