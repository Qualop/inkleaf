import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const env={...process.env,CLANG_MODULE_CACHE_PATH:path.join(root,'.cache/clang'),SWIFTPM_MODULECACHE_OVERRIDE:path.join(root,'.cache/ModuleCache')};
if(existsSync('/Applications/Xcode.app/Contents/Developer'))env.DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer';
const child=spawn('swift',['test','--disable-keychain','--disable-sandbox','--scratch-path','.build'],{cwd:root,env,stdio:'inherit'});
child.once('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
