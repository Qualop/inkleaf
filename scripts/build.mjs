import {spawn} from 'node:child_process';
import {cp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const cache=path.join(root,'.cache');await mkdir(cache,{recursive:true});
const env={...process.env,
  CLANG_MODULE_CACHE_PATH:path.join(cache,'clang'),SWIFTPM_MODULECACHE_OVERRIDE:path.join(cache,'ModuleCache')};
if(!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer'))env.DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer';
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const updateKey=(await readFile(path.join(root,'resources/update-public-key.txt'),'utf8')).trim();
if(Buffer.from(updateKey,'base64').length!==32)throw new Error('A valid public update signing key is required.');
async function run(command,args,capture=false){return await new Promise((resolve,reject)=>{
  let output='';const child=spawn(command,args,{cwd:root,env,stdio:capture?['ignore','pipe','inherit']:'inherit'});
  if(capture)child.stdout.on('data',chunk=>output+=chunk);
  child.once('error',reject);child.once('exit',code=>code===0?resolve(output.trim()):reject(new Error(`${command} exited ${code}`)));
});}
await run(process.execPath,[path.join(root,'scripts/build-web.mjs')]);
await run('swift',['build','--disable-keychain','--disable-sandbox','--scratch-path','.build','-c','release']);
const bin=await run('swift',['build','--disable-keychain','--disable-sandbox','--scratch-path','.build','-c','release','--show-bin-path'],true);
const app=path.join(root,'build/Inkleaf.app');const contents=path.join(app,'Contents');
await rm(app,{recursive:true,force:true});
await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(contents,'Resources'),{recursive:true});
for(const variant of ['ink','leaf']){
const iconset=path.join(cache,`AppIcon-${variant}.iconset`);
await mkdir(iconset,{recursive:true});
for(const size of [16,32,128,256,512]){
  for(const scale of [1,2]){
    const pixels=size*scale;
    await run('/usr/bin/sips',['-z',String(pixels),String(pixels),path.join(root,`resources/AppIcon-${variant}.png`),'--out',path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)],true);
  }
}
await run('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(contents,`Resources/AppIcon-${variant}.icns`)]);
}
await cp(path.join(contents,'Resources/AppIcon-ink.icns'),path.join(contents,'Resources/AppIcon.icns'));
await cp(path.join(bin,'Inkleaf'),path.join(contents,'MacOS/Inkleaf'));
const frameworks=[];
for(const identity of await readdir(path.join(root,'.build/artifacts'))){
  const candidate=path.join(root,'.build/artifacts',identity,'Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework');
  if(existsSync(candidate))frameworks.push(candidate);
}
if(frameworks.length!==1)throw new Error('Expected one verified Sparkle framework from SwiftPM.');
await mkdir(path.join(contents,'Frameworks'),{recursive:true});
await cp(frameworks[0],path.join(contents,'Frameworks/Sparkle.framework'),{recursive:true,verbatimSymlinks:true});
await rm(path.join(contents,'Resources/app'),{recursive:true,force:true});
await cp(path.join(root,'web/dist'),path.join(contents,'Resources/app'),{recursive:true});
await writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Inkleaf</string><key>CFBundleDisplayName</key><string>Inkleaf</string>
<key>CFBundleIdentifier</key><string>dev.inkleaf.editor</string><key>CFBundleExecutable</key><string>Inkleaf</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleVersion</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>14.5</string>
<key>SUFeedURL</key><string>https://raw.githubusercontent.com/Qualop/inkleaf/main/updates/appcast.xml</string>
<key>SUPublicEDKey</key><string>${updateKey}</string>
<key>SUEnableAutomaticChecks</key><true/><key>SUAutomaticallyUpdate</key><false/>
<key>SUAllowsAutomaticUpdates</key><false/><key>SUEnableSystemProfiling</key><false/>
<key>SUVerifyUpdateBeforeExtraction</key><true/><key>SURequireSignedFeed</key><true/>
<key>SUSignedFeedFailureExpirationInterval</key><integer>0</integer>
<key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string>
<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>Markdown</string>
<key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Alternate</string>
<key>CFBundleTypeExtensions</key><array><string>md</string><string>markdown</string><string>txt</string><string>mdx</string><string>qmd</string></array>
</dict></array></dict></plist>`);
await cp(path.join(root,'LICENSE'),path.join(contents,'Resources/LICENSE.txt'));
await cp(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(contents,'Resources/THIRD_PARTY_NOTICES.md'));
await cp(path.join(root,'tools/SPARKLE_LICENSE.txt'),path.join(contents,'Resources/SPARKLE_LICENSE.txt'));
const tool=path.join(root,'tools/pandoc');
if(existsSync(tool)){
  await mkdir(path.join(contents,'Resources/tools'),{recursive:true});await cp(tool,path.join(contents,'Resources/tools/pandoc'));
  for(const name of ['PANDOC_LICENSE.txt','COPYING.md','pandoc-provenance.json'])await cp(path.join(root,'tools',name),path.join(contents,'Resources/tools',name));
}
await run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
process.stdout.write(`Mac app built: ${app}\n`);
