import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const out=path.join(root,'web/dist');
await mkdir(out,{recursive:true});
await rm(path.join(out,'app.js.map'),{force:true});
await rm(path.join(out,'vendor'),{recursive:true,force:true});
await build({entryPoints:[path.join(root,'web/client/app.ts')],bundle:true,format:'iife',target:'safari17.4',
  outfile:path.join(out,'app.js'),sourcemap:false,minify:false,logLevel:'warning'});
await cp(path.join(root,'web/index.html'),path.join(out,'index.html'));
await cp(path.join(root,'web/style.css'),path.join(out,'style.css'));
await mkdir(path.join(out,'icons'),{recursive:true});
for(const variant of ['ink','leaf'])await cp(path.join(root,`resources/AppIcon-${variant}.png`),path.join(out,`icons/${variant}.png`));
const math=path.join(out,'vendor/mathjax');await mkdir(math,{recursive:true});
// Ship the selected SVG engine and its dynamic packages, without duplicate combined engines.
for(const component of ['tex-svg-full.js','input','output','a11y','sre','ui','adaptors','core.js','loader.js','startup.js'])
  await cp(path.join(root,'node_modules/mathjax-classic/es5',component),path.join(math,component),{recursive:true});
await mkdir(path.join(out,'vendor/mermaid'),{recursive:true});
await cp(path.join(root,'node_modules/mermaid/dist/mermaid.min.js'),path.join(out,'vendor/mermaid/mermaid.min.js'));
const packages=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
let notices='Inkleaf independent Markdown editor\nThird-party components retain their licenses.\n\n';
for(const [location,locked] of Object.entries(packages.packages)){
  if(!location.startsWith('node_modules/')||locked.dev)continue;
  const dir=path.join(root,location);const meta=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
  notices+=`${meta.name} ${meta.version} (${typeof meta.license==='string'?meta.license:'see package'})\n`;
  for(const filename of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','license.txt','LICENCE','LICENSE-MIT','LICENSE-MIT.txt','COPYING']){
    try{notices+=await readFile(path.join(dir,filename),'utf8')+'\n';break;}catch{}
  }
  notices+='\n';
}
await writeFile(path.join(out,'THIRD_PARTY_NOTICES.txt'),notices);
process.stdout.write(`Web assets built: ${out}\n`);
