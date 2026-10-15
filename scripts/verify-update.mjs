import {readFile,writeFile,mkdir,rm,readdir,readlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {run,toolsDirectory,sparkleAccount} from './prepare-sparkle.mjs';
const root=path.resolve(import.meta.dirname,'..'),{version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const directory=path.join(root,'.cache/update-verification');await mkdir(directory,{recursive:true});
async function verifyInternalLinks(app){
 const base=await realpath(app);
 async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isSymbolicLink()){
   const target=await readlink(file),resolved=await realpath(file);
   if(path.isAbsolute(target)||!resolved.startsWith(base+path.sep))throw new Error(`App contains an external framework link: ${path.relative(app,file)}`);
  }else if(entry.isDirectory())await walk(file);
 }}
 await walk(app);
}
await verifyInternalLinks(path.join(root,'build/Inkleaf.app'));
await verifyInternalLinks(path.join(root,'.cache/dmg-stage/Inkleaf.app'));
const publicKey=(await readFile(path.join(root,'resources/update-public-key.txt'),'utf8')).trim();
const feed=await readFile(path.join(root,'dist/appcast.xml'),'utf8');
const signature=feed.match(/sparkle:edSignature="([^"]+)"/)?.[1];if(!signature)throw new Error('Missing update signature.');
const metadata=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(root,'build/Inkleaf.app/Contents/Info.plist')],{capture:true}));
if(metadata.SUPublicEDKey!==publicKey||metadata.CFBundleVersion!==version||metadata.SUFeedURL!=='https://raw.githubusercontent.com/Qualop/inkleaf/main/updates/appcast.xml')throw new Error('Bundle update metadata mismatch.');
for(const key of ['SUVerifyUpdateBeforeExtraction','SURequireSignedFeed','SUEnableAutomaticChecks'])if(metadata[key]!==true)throw new Error(`Missing ${key}`);
for(const key of ['SUAutomaticallyUpdate','SUAllowsAutomaticUpdates','SUEnableSystemProfiling'])if(metadata[key]!==false)throw new Error(`Unexpected ${key}`);
if(metadata.SUSignedFeedFailureExpirationInterval!==0)throw new Error('Signed feed validation must not expire.');
const archive=path.join(root,`dist/Inkleaf-${version}-macOS-${process.arch}.dmg`);
await writeFile(path.join(directory,'Verify.swift'),`import Foundation
import CryptoKit
let key = try Curve25519.Signing.PublicKey(rawRepresentation: Data(base64Encoded: CommandLine.arguments[1])!)
let signature = Data(base64Encoded: CommandLine.arguments[2])!
var bytes = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))
guard key.isValidSignature(signature, for: bytes) else { fatalError("Published archive does not match embedded public key") }
bytes[bytes.startIndex] ^= 1
guard !key.isValidSignature(signature, for: bytes) else { fatalError("Modified archive was accepted") }
print("Archive matches embedded public key; modified archive rejected.")
`);
const env={...process.env,DEVELOPER_DIR:'/Applications/Xcode.app/Contents/Developer',CLANG_MODULE_CACHE_PATH:path.join(root,'.cache/clang'),SWIFTPM_MODULECACHE_OVERRIDE:path.join(root,'.cache/ModuleCache')};
await new Promise((resolve,reject)=>{const child=spawn('swiftc',[path.join(directory,'Verify.swift'),'-o',path.join(directory,'verify')],{cwd:root,env,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Signature verifier compilation failed.')));});
await run(path.join(directory,'verify'),[publicKey,signature,archive]);
const signer=path.join(toolsDirectory,'bin/sign_update');await run(signer,['--account',sparkleAccount,'--verify',path.join(root,'dist/appcast.xml')]);
const altered=path.join(directory,'altered.xml');await writeFile(altered,feed.replace(`<title>${version}</title>`,'<title>9.9.9</title>'));
let rejected=false;try{await run(signer,['--account',sparkleAccount,'--verify',altered],{capture:true});}catch{rejected=true;}finally{await rm(altered,{force:true});}
if(!rejected)throw new Error('Modified signed feed was accepted.');
await run('/usr/bin/codesign',['--verify','--deep','--strict',path.join(root,'build/Inkleaf.app')]);
await writeFile(path.join(directory,'result.json'),JSON.stringify({version,archiveSignature:true,modifiedArchiveRejected:true,feedSignature:true,modifiedFeedRejected:true,bundleMetadata:true,nestedSignature:true},null,2)+'\n');
console.log('Update archive, feed, tamper rejection, bundle configuration and nested signatures verified.');
