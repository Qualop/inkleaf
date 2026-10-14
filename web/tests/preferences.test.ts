import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { undo, redo } from '@codemirror/commands';
import { NativeClient, normalizeSnapshot } from '../client/bridge.ts';
import { DocumentEditor } from '../client/editor.ts';
import { mountApp } from '../client/app.ts';
const dom = new JSDOM('<!doctype html><html><body><div id="preferences-root"></div></body></html>', { url: 'https://mori.local/', pretendToBeVisual: true });
const win = dom.window;
for (const key of ['window', 'Window', 'Document', 'document', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'DOMRect', 'Range', 'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'AbortController', 'AbortSignal', 'DOMParser']) Object.defineProperty(globalThis, key, { value: key === 'window' ? win : (win as any)[key], configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
Object.defineProperty(globalThis, 'getComputedStyle', { value: win.getComputedStyle.bind(win), configurable: true });
Object.defineProperty(globalThis, 'requestAnimationFrame', { value: win.requestAnimationFrame.bind(win), configurable: true });
Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: win.cancelAnimationFrame.bind(win), configurable: true });
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {}; } });
(win.Range.prototype as any).getBoundingClientRect = rect;
(win.Range.prototype as any).getClientRects = () => [];
win.HTMLElement.prototype.getBoundingClientRect = rect;
(win as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
win.HTMLElement.prototype.scrollIntoView = function () {};
function root() { const element = document.getElementById('preferences-root')!; element.replaceChildren(); return element; }

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const snapshot=(id:string,path:string|null,text:string)=>({documentId:id,path,text,revision:0,savedDigest:path?'disk':null,encoding:'utf8',lineEnding:'LF'});
function host(settings:any={},initialPath:string|null='/A.md',initialSource='# A\nhello😀'){
  const messages:any[]=[],records=new Map([['a',snapshot('a',initialPath,initialSource)],['b',snapshot('b','/B.md','# B\nworld')]]);
  (win as any).webkit={messageHandlers:{native:{postMessage:(message:any)=>{messages.push(message);queueMicrotask(()=>{
    let result:any={};if(message.method==='bootstrap')result={settings:{language:'en',...settings},recoveries:[]};else if(message.method==='createDocument')result=records.get('a');else if(message.method==='chooseDocument')result=records.get('b');
    else if(message.method==='saveAs'){result={...records.get(message.args.documentId),path:'/Saved.md',text:message.args.text,revision:message.args.revision,savedDigest:'saved'};records.set(message.args.documentId,result);}
    else if(message.method==='manageFile'){result={path:message.args.destination,document:{...records.get(message.args.documentId),path:message.args.destination}};records.set(message.args.documentId,result.document);}
    (win as any).__nativeReply({id:message.id,ok:true,result});
  });}}}};return messages;
}
function change(key:string,value:string|boolean){const element=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[data-setting="${key}"]`)!;assert.ok(element,key);if(typeof value==='boolean')(element as HTMLInputElement).checked=value;else element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));}
function scope(value:boolean){const element=document.querySelector<HTMLInputElement>('[data-document-preference-scope]')!;assert.ok(element);element.checked=value;element.dispatchEvent(new Event('change',{bubbles:true}));}
function closeDialog(){document.querySelector<HTMLButtonElement>('dialog header button')?.click();}
function activateA(){document.querySelector<HTMLButtonElement>('[data-document="a"] [role="tab"]')!.click();}
function size(){return document.getElementById('preferences-root')!.style.getPropertyValue('--font-size');}

test('document scope applies real consumers only to A and never persists them as global defaults',async()=>{
  const messages=host({fontSize:18,pinnedFolders:['/pin'],recentFiles:['/History.md'],pandocPath:'/tools/pandoc'}),app=await mountApp(root());try{
    app.editor.replace('# A\nhello😀!');await app.action('settings');scope(true);change('fontSize','28');change('tabSize','8');change('wrap',false);change('mathNumbering','ams');await tick();
    assert.equal(size(),'28px');assert.equal(app.editor.view.state.tabSize,8);assert.equal(app.editor.view.contentDOM.classList.contains('cm-lineWrapping'),false);assert.equal(app.preferences.mathNumbering,'ams');
    const values=messages.filter(m=>m.method==='settings').at(-1).args.values;assert.equal(values.fontSize,18);assert.equal(values.tabSize,4);assert.equal(values.documentOverrides['/A.md'].fontSize,28);assert.equal(values.documentOverrides['/A.md'].tabSize,8);assert.equal(values.documentOverrides['/A.md'].mathNumbering,'ams');
    for(const key of ['session','recentFiles','pinnedFolders','pandocPath','imageUploaderPath','language'])assert.equal(Object.hasOwn(values.documentOverrides['/A.md'],key),false,key);
    assert.equal(document.querySelector<HTMLInputElement>('[data-setting="pandocPath"]')!.disabled,true);
    assert.equal(app.editor.text(),'# A\nhello😀!');closeDialog();await app.action('open');assert.equal(size(),'18px');assert.equal(app.editor.view.state.tabSize,4);
    activateA();assert.equal(size(),'28px');assert.equal(app.editor.view.state.tabSize,8);assert.equal(app.editor.text(),'# A\nhello😀!');undo(app.editor.view);assert.equal(app.editor.text(),'# A\nhello😀');
  }finally{app.destroy();}
});
test('global changes remain global and resetting current overrides preserves other files, pins and history',async()=>{
  const messages=host({pinnedFolders:['/pin'],recentFiles:['/History.md'],documentOverrides:{'/B.md':{fontSize:30}}}),app=await mountApp(root());try{
    await app.action('settings');scope(true);change('fontSize','28');closeDialog();await app.action('open');assert.equal(size(),'30px');
    await app.action('settings');scope(false);change('fontSize','22');await tick();assert.equal(size(),'22px');closeDialog();activateA();assert.equal(size(),'28px');
    await app.action('settings');document.querySelector<HTMLButtonElement>('[data-action="reset-document-settings"]')!.click();await tick();assert.equal(size(),'22px');assert.equal(Object.hasOwn(app.preferences.documentOverrides,'/A.md'),false);
    const values=messages.filter(m=>m.method==='settings').at(-1).args.values;assert.deepEqual(values.pinnedFolders,['/pin']);assert.ok(values.recentFiles.includes('/History.md'));assert.deepEqual(values.session.paths,['/A.md','/B.md']);assert.equal(app.editor.text(),'# A\nhello😀');
  }finally{app.destroy();}
});
test('stored overrides validate the allowlist and feed rendering without importing executable paths or history',async()=>{
  host({pandocPath:'/tools/pandoc',pinnedFolders:['/pin'],documentOverrides:{'/A.md':{fontSize:26,renderHTML:false,autoLinks:false,mathPhysics:true,wrap:'bad',tabSize:500,pandocPath:'/evil',session:{paths:['/evil']},pinnedFolders:['/evil']}}},'/A.md','# A\n<strong>literal</strong>\nhttps://example.invalid');const app=await mountApp(root());try{
    assert.equal(size(),'26px');assert.equal(app.preferences.pandocPath,'/tools/pandoc');assert.deepEqual(app.preferences.pinnedFolders,['/pin']);assert.equal(app.preferences.wrap,true);assert.equal(app.editor.view.state.tabSize,4);assert.equal(app.preferences.mathPhysics,true);
    const keys=Object.keys(app.preferences.documentOverrides['/A.md']).sort();assert.deepEqual(keys,['autoLinks','fontSize','mathPhysics','renderHTML']);
    app.setMode('reading');assert.equal(document.querySelector('.reading strong'),null);assert.equal(document.querySelector('.reading a'),null);assert.match(document.querySelector('.reading')!.textContent!,/<strong>literal<\/strong>/);
  }finally{app.destroy();}
});
test('untitled overrides migrate to the saved filepath and then to a renamed filepath',async()=>{
  const messages=host({},null),app=await mountApp(root());try{
    await app.action('settings');scope(true);change('fontSize','25');closeDialog();assert.equal(app.preferences.documentOverrides['id:a'].fontSize,25);await app.save();assert.equal(app.preferences.documentOverrides['/Saved.md'].fontSize,25);assert.equal(Object.hasOwn(app.preferences.documentOverrides,'id:a'),false);
    await app.action('document-files');[...document.querySelectorAll<HTMLButtonElement>('dialog footer button')].find(b=>b.textContent==='Rename File')!.click();document.querySelector<HTMLInputElement>('dialog input')!.value='Renamed.md';[...document.querySelectorAll<HTMLButtonElement>('dialog footer button')].find(b=>b.textContent==='Rename File')!.click();await tick();await tick();
    assert.ok(app.preferences.documentOverrides['/Renamed.md'],JSON.stringify({path:app.documents.get('a')!.path,keys:Object.keys(app.preferences.documentOverrides),status:document.querySelector('[data-message]')!.textContent}));assert.equal(app.preferences.documentOverrides['/Renamed.md'].fontSize,25);assert.equal(Object.hasOwn(app.preferences.documentOverrides,'/Saved.md'),false);assert.equal(size(),'25px');assert.equal(messages.filter(m=>m.method==='settings').at(-1).args.values.documentOverrides['/Renamed.md'].fontSize,25);
  }finally{app.destroy();}
});
test('scoped settings dialogs cannot change a different active document',async()=>{
  host();const app=await mountApp(root());try{
    await app.action('settings');scope(true);await app.action('open');change('fontSize','28');assert.equal(size(),'18px');assert.equal(app.preferences.documentOverrides['/A.md'].fontSize,18);assert.equal(app.preferences.documentOverrides['/B.md'],undefined);assert.match(document.querySelector('[data-message]')!.textContent!,/original document|switch back/i);
  }finally{app.destroy();}
});
test('Korean localizes chrome and new common dialogs while filenames, outline and source stay unchanged',async()=>{
  const messages=host({},'/Save','# Settings\nOpen Save'),app=await mountApp(root());try{
    app.editor.replace('# Settings\nOpen Save!');await app.action('settings');change('language','ko');await tick();
    assert.equal(document.querySelector('[data-action="save"]')!.textContent,'저장');assert.equal(document.querySelector('dialog h2')!.textContent,'설정');assert.equal(document.querySelector('[data-document="a"] [role="tab"]')!.textContent,'Save');assert.equal(document.querySelector('[data-outline-title]')!.textContent,'Settings');assert.equal(app.editor.text(),'# Settings\nOpen Save!');
    assert.equal(messages.filter(m=>m.method==='settings').at(-1).args.values.language,'ko');await app.action('export-options');await tick();assert.equal(document.querySelector('dialog h2')!.textContent,'문서 내보내기');assert.equal(document.querySelector('[data-action="export-apply"]')!.textContent,'내보내기');
    await app.action('settings');change('language','en');await tick();assert.equal(document.querySelector('[data-action="save"]')!.textContent,'Save');assert.equal(document.querySelector('dialog h2')!.textContent,'Settings');undo(app.editor.view);assert.equal(app.editor.text(),'# Settings\nOpen Save');
  }finally{app.destroy();}
});
test('global reset uses the native reset operation while retaining session, histories and document overrides',async()=>{
  const messages=host({pinnedFolders:['/pin'],recentFiles:['/History.md'],fontSize:24}),app=await mountApp(root());try{
    await app.action('settings');scope(true);change('fontSize','28');document.querySelector<HTMLButtonElement>('[data-action="reset-settings"]')!.click();await tick();
    const reset=messages.filter(m=>m.method==='settings'&&m.args.operation==='reset').at(-1);assert.ok(reset);assert.equal(reset.args.values.fontSize,18);assert.equal(reset.args.values.documentOverrides['/A.md'].fontSize,28);assert.deepEqual(reset.args.values.pinnedFolders,['/pin']);assert.ok(reset.args.values.recentFiles.includes('/History.md'));assert.equal(app.editor.text(),'# A\nhello😀');
  }finally{app.destroy();}
});
test('document rendering overrides remain bound to an export while a different tab becomes active',async()=>{
  const messages=host({mode:'source',documentOverrides:{'/A.md':{renderHTML:false}}},'/A.md','# A\n<strong>literal</strong>\n![a](assets/a.png)');
  const pending:any[]=[],original=(win as any).webkit.messageHandlers.native.postMessage;(win as any).webkit.messageHandlers.native.postMessage=(message:any)=>{if(message.method==='readAsset')pending.push(message);else original(message);};
  const app=await mountApp(root());try{
    const exporting=app.export('html');await tick();assert.equal(pending.length,1);await app.action('open');
    for(const message of pending)(win as any).__nativeReply({id:message.id,ok:true,result:{type:'image/png',base64:'AA=='}});await exporting;
    const content=messages.find(message=>message.method==='export').args.content;assert.match(content,/&lt;strong&gt;literal&lt;\/strong&gt;/);assert.doesNotMatch(content,/<strong>literal<\/strong>/);assert.equal(app.editor.text(),'# B\nworld');
  }finally{app.destroy();}
});

test('app icon defaults and invalid stored values normalize to ink before persistence',async()=>{
  for(const value of [undefined,null,'concept1','INK','',42,{},['leaf']]){
    const messages=host({appIcon:value}),app=await mountApp(root());try{
      assert.equal(app.preferences.appIcon,'ink',JSON.stringify(value));
      await app.action('settings');change('fontSize','20');await tick();
      assert.equal(messages.filter(m=>m.method==='settings').at(-1).args.values.appIcon,'ink');
      assert.equal(document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="ink"]')?.checked,true);
    }finally{app.destroy();}
  }
});

test('appearance icon choices expose labeled previews and localized scope help',async()=>{
  host({appIcon:'leaf'});const app=await mountApp(root());try{
    await app.action('settings');
    document.querySelector<HTMLButtonElement>('[data-settings-category="appearance"]')!.click();
    const choices=[...document.querySelectorAll<HTMLInputElement>('input[data-setting="appIcon"]')];
    assert.equal(choices.length,2);
    const group=choices[0].closest('fieldset')!;assert.ok(group);assert.equal(group.closest<HTMLElement>('[role="tabpanel"]')!.hidden,false);
    assert.equal(group.querySelector('legend')!.textContent,'App icon (all documents)');
    for(const [index,value,name] of [[0,'ink','Black Ink'],[1,'leaf','Green Leaf']] as const){
      const choice=choices[index];assert.equal(choice.type,'radio');assert.equal(choice.value,value);
      assert.equal(choice.name,choices[0].name);assert.equal(choice.checked,value==='leaf');
      const label=choice.labels![0];assert.equal(label.textContent,name);
      const preview=label.querySelector('img')!;assert.ok(preview);assert.equal(preview.getAttribute('src'),`icons/${value}.png`);assert.equal(preview.alt,'');
    }
    const help=document.getElementById(group.getAttribute('aria-describedby')!)!;assert.ok(help);
    assert.match(help.textContent!,/Dock.*app.switcher/);assert.match(help.textContent!,/Finder.*installer.*default/);
    change('language','ko');await tick();
    assert.equal(group.querySelector('legend')!.textContent,'앱 아이콘 (모든 문서)');
    assert.deepEqual(choices.map(choice=>choice.labels![0].textContent),['검은 잉크','초록 잎']);
    assert.match(help.textContent!,/Dock.*앱 전환/);assert.match(help.textContent!,/Finder.*설치.*기본/);
    assert.match(document.querySelector('[data-scope-note]')!.textContent!,/앱 아이콘.*앱 전체/);
    change('language','en');await tick();assert.deepEqual(choices.map(choice=>choice.labels![0].textContent),['Black Ink','Green Leaf']);
  }finally{app.destroy();}
});

test('icon selection immediately uses native settings, remains global across tabs and restores on launch',async()=>{
  const messages=host({documentOverrides:{'/A.md':{fontSize:26,appIcon:'leaf'},'/B.md':{appIcon:'leaf'}}}),app=await mountApp(root());
  let saved:any;
  try{
    assert.equal(app.preferences.appIcon,'ink');assert.equal(Object.hasOwn(app.preferences.documentOverrides['/A.md'],'appIcon'),false);
    assert.equal(app.preferences.documentOverrides['/B.md'],undefined);
    await app.action('settings');
    const leaf=document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="leaf"]')!;assert.ok(leaf);assert.equal(leaf.disabled,false);
    leaf.click();assert.equal(app.preferences.appIcon,'leaf');await tick();
    saved=messages.filter(m=>m.method==='settings').at(-1).args.values;
    assert.equal(saved.appIcon,'leaf');assert.equal(Object.hasOwn(saved.documentOverrides['/A.md'],'appIcon'),false);
    closeDialog();await app.action('open');assert.equal(app.preferences.appIcon,'leaf');activateA();assert.equal(app.preferences.appIcon,'leaf');
    await app.action('settings');scope(false);scope(true);
    assert.equal(Object.hasOwn(app.preferences.documentOverrides['/A.md'],'appIcon'),false);
    const ink=document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="ink"]')!;assert.equal(ink.disabled,false);ink.click();await tick();
    assert.equal(app.preferences.appIcon,'ink');assert.equal(messages.filter(m=>m.method==='settings').at(-1).args.values.appIcon,'ink');
    assert.equal(Object.hasOwn(app.preferences.documentOverrides['/A.md'],'appIcon'),false);
    document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="leaf"]')!.click();await tick();
    saved=messages.filter(m=>m.method==='settings').at(-1).args.values;
  }finally{app.destroy();}
  host(saved);const restored=await mountApp(root());try{
    assert.equal(restored.preferences.appIcon,'leaf');await restored.action('settings');
    assert.equal(document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="leaf"]')!.checked,true);
  }finally{restored.destroy();}
});

test('reset restores ink through native reset while preserving valid document overrides',async()=>{
  const messages=host({appIcon:'leaf',documentOverrides:{'/A.md':{fontSize:28,appIcon:'leaf'}}}),app=await mountApp(root());try{
    await app.action('settings');document.querySelector<HTMLButtonElement>('[data-action="reset-settings"]')!.click();await tick();
    assert.equal(app.preferences.appIcon,'ink');
    const reset=messages.filter(m=>m.method==='settings'&&m.args.operation==='reset').at(-1);assert.ok(reset);
    assert.equal(reset.args.values.appIcon,'ink');assert.deepEqual(reset.args.values.documentOverrides['/A.md'],{fontSize:28});
    await app.action('settings');assert.equal(document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="ink"]')!.checked,true);
  }finally{app.destroy();}
});

test('settings display awaits an authoritative icon read and imports no other preferences',async()=>{
  host({appIcon:'ink',fontSize:22,pinnedFolders:['/local'],documentOverrides:{'/A.md':{fontSize:28}}});
  const pending:any[]=[],original=(win as any).webkit.messageHandlers.native.postMessage;
  (win as any).webkit.messageHandlers.native.postMessage=(message:any)=>{if(message.method==='settings'&&message.args.operation==='read')pending.push(message);else original(message);};
  const app=await mountApp(root());try{
    const opening=app.action('settings');await tick();
    assert.equal(document.querySelector('dialog'),null,'wait for the icon read before showing stale radios');
    assert.equal(pending.length,1);
    (win as any).__nativeReply({id:pending[0].id,ok:true,result:{appIcon:'leaf',fontSize:36,language:'ko',pinnedFolders:['/remote'],documentOverrides:{}}});
    await opening;
    assert.equal(app.preferences.appIcon,'leaf');assert.equal(app.preferences.language,'en');assert.equal(app.preferences.fontSize,28);
    assert.deepEqual(app.preferences.pinnedFolders,['/local']);assert.deepEqual(app.preferences.documentOverrides['/A.md'],{fontSize:28});
    assert.equal(document.querySelector<HTMLInputElement>('[data-setting="appIcon"][value="leaf"]')!.checked,true);
    closeDialog();await app.action('open');assert.equal(app.preferences.appIcon,'leaf');assert.equal(app.preferences.fontSize,22);
  }finally{app.destroy();}
});

test('two windows refresh icon selection on settings display before changing or resetting it',async()=>{
  const shared:Record<string,any>={appIcon:'ink',language:'en',fontSize:18},writes:any[]=[];
  function client(id:string){
    let baseline:Record<string,any>={};const target:any={};
    target.webkit={messageHandlers:{native:{postMessage(message:any){queueMicrotask(()=>{
      let result:any={};
      if(message.method==='bootstrap'){baseline=structuredClone(shared);result={settings:structuredClone(shared),recoveries:[]};}
      else if(message.method==='createDocument')result=snapshot(id,`/${id}.md`,'');
      else if(message.method==='settings'){
        if(message.args.operation==='read'){
          baseline.appIcon=shared.appIcon;result=structuredClone(shared);
        }else{
          const values=message.args.values;
          const changed=message.args.operation==='reset'?values:Object.fromEntries(Object.entries(values).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(baseline[key])));
          Object.assign(shared,structuredClone(changed));baseline=structuredClone(values);writes.push({id,operation:message.args.operation,changed:structuredClone(changed)});result=structuredClone(shared);
        }
      }
      target.__nativeReply({id:message.id,ok:true,result});
    });}}}};return new NativeClient(target as Window);
  }
  const container=root(),aRoot=document.createElement('div'),bRoot=document.createElement('div');container.append(aRoot,bRoot);
  const a=await mountApp(aRoot,client('A')),b=await mountApp(bRoot,client('B'));
  const pick=(element:HTMLElement,value:string)=>element.querySelector<HTMLInputElement>(`[data-setting="appIcon"][value="${value}"]`)!.click();
  const checked=(element:HTMLElement)=>element.querySelector<HTMLInputElement>('[data-setting="appIcon"]:checked')!.value;
  const close=(element:HTMLElement)=>element.querySelector<HTMLButtonElement>('dialog header button')!.click();
  try{
    await a.action('settings');pick(aRoot,'leaf');await tick();assert.equal(shared.appIcon,'leaf');close(aRoot);
    assert.equal(b.preferences.appIcon,'ink');await b.action('settings');assert.equal(checked(bRoot),'leaf');
    pick(bRoot,'ink');await tick();assert.equal(shared.appIcon,'ink');assert.equal(writes.at(-1).changed.appIcon,'ink');close(bRoot);
    await a.action('settings');assert.equal(checked(aRoot),'ink');pick(aRoot,'leaf');await tick();assert.equal(shared.appIcon,'leaf');close(aRoot);
    await b.action('settings');assert.equal(checked(bRoot),'leaf');
    bRoot.querySelector<HTMLButtonElement>('[data-action="reset-settings"]')!.click();await tick();
    assert.equal(shared.appIcon,'ink');assert.equal(writes.at(-1).operation,'reset');assert.equal(writes.at(-1).changed.appIcon,'ink');
    await a.action('settings');assert.equal(checked(aRoot),'ink');
  }finally{b.destroy();a.destroy();}
});

test('visible app branding uses Inkleaf in document titles, recovery and settings help',async()=>{
  host();const app=await mountApp(root());try{
    assert.equal(document.title,'A.md · Inkleaf');
    await app.action('recoveries');assert.match(document.querySelector('dialog')!.textContent!,/Inkleaf checkpoints/);
    await app.action('settings');assert.match(document.querySelector('[data-setting-hint="restoreSession"]')!.textContent!,/Inkleaf starts/);
    assert.match(document.querySelector('[data-setting-hint="watchFiles"]')!.textContent!,/Inkleaf keeps/);
    assert.match(document.querySelector('[data-setting-hint="pandocPath"]')!.textContent!,/Inkleaf includes/);
  }finally{app.destroy();}
  const client=new NativeClient({} as Window);try{
    await assert.rejects(client.call('bootstrap'),/Open Inkleaf as a desktop app/);
  }finally{client.dispose();}
});
