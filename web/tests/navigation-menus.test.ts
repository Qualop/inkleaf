import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMANDS } from '../core/commands.ts';

test('Mac menu inventory dispatches every tagged callback, retains locale mappings and advertises unique shortcuts', {skip:process.platform!=='darwin',timeout:90000},t=>{
  const root=path.resolve(import.meta.dirname,'../..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'inkleaf-navigation-menus-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const bridge=fs.readFileSync(path.join(root,'Sources/Mori/Bridge.swift'),'utf8');
  const command=bridge.slice(bridge.indexOf('struct NativeCommand:'),bridge.indexOf('@MainActor'));
  fs.writeFileSync(path.join(temporary,'Probe.swift'),`
import AppKit
import DocumentCore
${command}
@main struct Probe {
  @MainActor static func main() throws {
    var sent:[NativeCommand]=[]
    let menus=Menus { sent.append($0) }
    let bar=menus.makeMenu()
    func collect(_ menu:NSMenu,_ parent:[String]=[])->[[String:Any]] {
      menu.items.filter{!$0.isSeparatorItem}.flatMap { item -> [[String:Any]] in
        let path=parent+[item.title]
        var row:[String:Any]=["title":item.title,"path":path,"key":item.keyEquivalent,"modifiers":item.keyEquivalentModifierMask.rawValue]
        if item.target === menus,let action=item.action {
          let count=sent.count
          _=menus.perform(action,with:item)
          precondition(sent.count==count+1)
          row["command"]=sent.last!.json.foundationValue
        } else if let action=item.action { row["native"]=NSStringFromSelector(action) }
        return [row]+(item.submenu.map{collect($0,path)} ?? [])
      }
    }
    let ko=collect(bar)
    Menus.setLanguage("en")
    let en=collect(bar)
    Menus.setLanguage("ko")
    let restored=collect(bar)
    print(String(data:try JSONSerialization.data(withJSONObject:["ko":ko,"en":en,"restored":restored]),encoding:.utf8)!)
  }
}`);
  const env={...process.env,CLANG_MODULE_CACHE_PATH:path.join(temporary,'clang-cache')};
  if(fs.existsSync('/Applications/Xcode.app/Contents/Developer'))env.DEVELOPER_DIR='/Applications/Xcode.app/Contents/Developer';
  const compile=(args:string[])=>execFileSync('/usr/bin/swiftc',['-swift-version','6','-module-cache-path',path.join(temporary,'module-cache'),...args],{cwd:temporary,env,encoding:'utf8',timeout:60000});
  compile(['-emit-library','-emit-module','-module-name','DocumentCore',path.join(root,'Sources/DocumentCore/Types.swift'),'-o',path.join(temporary,'libDocumentCore.dylib')]);
  compile(['-I',temporary,'-L',temporary,'-lDocumentCore','-Xlinker','-rpath','-Xlinker',temporary,path.join(root,'Sources/Mori/Menus.swift'),path.join(temporary,'Probe.swift'),'-o',path.join(temporary,'probe')]);
  const result=JSON.parse(execFileSync(path.join(temporary,'probe'),{cwd:temporary,env,encoding:'utf8',timeout:10000}));
  assert.deepEqual(result.ko,result.restored);
  const callbacks=(rows:any[])=>rows.filter(row=>row.command).map(row=>row.command);
  assert.deepEqual(callbacks(result.ko),callbacks(result.en));
  const app=fs.readFileSync(path.join(root,'web/client/app.ts'),'utf8');
  const actionBody=app.slice(app.indexOf('async action(action:'),app.indexOf('private selectedText()'));
  const actions=new Set([...actionBody.matchAll(/case '([^']+)'/g)].map(match=>match[1]));
  const aliases:Record<string,string>={openFolder:'folder',saveAs:'save-as',insertImage:'insert-image',pastePlain:'paste-plain',copyMarkdown:'copy-markdown',copyPlain:'copy-plain',copyHTML:'copy-html',searchWorkspace:'workspace-search',replace:'find',quickOpen:'quick-open'};
  const emitted=new Set(callbacks(result.en).map(command=>aliases[command.type]??command.type));
  for(const type of [...actions,...COMMANDS.map(command=>command.type)])assert.ok(emitted.has(type),`No native callback for ${type}`);
  const seen=new Map<string,string>();
  for(const row of result.en)if(row.key){const key=`${row.modifiers}:${row.key}`;assert.ok(!seen.has(key),`${row.title} conflicts with ${seen.get(key)}`);seen.set(key,row.title);}
  const commandModifier=1<<20,optionModifier=1<<19,shiftModifier=1<<17;
  for(const [label,type,key,modifiers] of [['Settings…','settings',',',commandModifier],['Quick Open…','quickOpen','o',commandModifier|optionModifier],['Find…','find','f',commandModifier],['Next Match','next-match','g',commandModifier],['Previous Match','previous-match','g',commandModifier|shiftModifier],['Print…','print','p',commandModifier]]){
    const row=result.en.find((row:any)=>row.title===label);assert.equal(row?.command?.type,type);assert.equal(row.key,key);assert.equal(row.modifiers,modifiers,`${label} advertised modifiers`);
  }
  for(const [label,selector] of [['Cut','cut:'],['Copy','copy:'],['Paste','paste:'],['Close Window','performClose:']])assert.ok(result.en.some((row:any)=>row.title===label&&row.native===selector));
  const inventory=result.en.filter((row:any)=>row.command||row.native);
  console.log(`Mac inventory: ${callbacks(result.en).length} callbacks, ${inventory.length-callbacks(result.en).length} responder actions, ${seen.size} unique shortcuts.`);
});
