import test from 'node:test';
import {resolveImageReferences} from '../core/images.ts';
import assert from 'node:assert/strict';
test('reference images resolve to inline URLs without changing shared links or code examples',()=>{
  const source='![그림][Pic] [link][Pic]\n\n![Pic][]\n\n`![그림][Pic]`\n\n[Pic]: <assets/a b.png> "제목"\n';
  assert.equal(resolveImageReferences(source),'![그림](assets/a%20b.png "제목") [link][Pic]\n\n![Pic](assets/a%20b.png "제목")\n\n`![그림][Pic]`\n\n[Pic]: <assets/a b.png> "제목"\n');
});
import { discoverImages, localImagePlan, parseUploaderArguments, parseUploadOutput, replaceImageURLs, convertImageSyntax, relativeImageURLs, uploadImages, planImageFileOperation, manageImageFiles } from '../core/images.ts';

const source = '![한글](<assets/a b.png> "title")\r\n<img src="assets/c.png" alt="C" width="42">\r\n`![code](assets/a b.png)`\r\n```md\r\n![fence](assets/c.png)\r\n```\r\n[link](assets/c.png)';
test('discovers only actual Markdown and HTML images with precise URL ranges', () => {
  const images = discoverImages(source);
  assert.deepEqual(images.map(image => image.url), ['assets/a b.png', 'assets/c.png']);
  for (const image of images) assert.equal(source.slice(image.urlFrom,image.urlTo), image.url);
  assert.equal(discoverImages('<!-- <img src="x"> -->\n<pre><img src="x"></pre>\n    ![x](code.png)').length, 0);
});
test('URL replacements preserve unknown HTML attributes, titles, CRLF and code source', () => {
  const images = discoverImages(source);
  assert.equal(replaceImageURLs(source, images, ['https://example.invalid/a.png', 'https://example.invalid/c.png']), source.replace('assets/a b.png>','https://example.invalid/a.png>').replace('src="assets/c.png"','src="https://example.invalid/c.png"'));
  assert.throws(() => replaceImageURLs(source + '!', images, ['a','b'], source), /changed/);
  assert.throws(() => replaceImageURLs(source, images, ['a']), /count/);
});
test('local plan decodes distinct file arguments, deduplicates and respects selection', () => {
  const text = '![a](assets/a%20b.png) ![again](assets/a%20b.png) <img src="file:///notes/c.png"> ![remote](https://example.invalid/x)';
  const plan = localImagePlan(text, '/notes');
  assert.deepEqual(plan.paths, ['/notes/assets/a b.png', '/notes/c.png']);
  assert.equal(plan.images.length, 3);
  assert.deepEqual(localImagePlan(text,'/notes',{from:text.indexOf('<img'),to:text.indexOf('<img')}).paths, ['/notes/c.png']);
  assert.throws(() => localImagePlan('![a](a.png)',undefined), /Save|root/);
  assert.throws(() => localImagePlan('![a](file://server/a.png)','/notes'), /Unsupported/);
});
test('uploader arguments require a JSON string array and preserve shell characters literally', () => {
  assert.deepEqual(parseUploaderArguments('["--bucket", "a b", "$(no)", "`literal`"]'), ['--bucket','a b','$(no)','`literal`']);
  for (const text of ['--bad','{}','[1]','[null]','["a\\u0000b"]']) assert.throws(() => parseUploaderArguments(text), /JSON|string|NUL/);
});
test('uploader accepts strict JSON arrays, urls objects or newline URLs with exact count', () => {
  assert.deepEqual(parseUploadOutput('["https://example.invalid/a","https://example.invalid/b"]',2), ['https://example.invalid/a','https://example.invalid/b']);
  assert.deepEqual(parseUploadOutput('{"urls":["https://example.invalid/a"]}',1), ['https://example.invalid/a']);
  assert.deepEqual(parseUploadOutput('https://example.invalid/a\nhttps://example.invalid/b\n',2), ['https://example.invalid/a','https://example.invalid/b']);
  for(const output of ['https://example.invalid/a','{"urls":["https://example.invalid/a"],"errors":["failed"]}','["https://example.invalid/a",null]','done\nhttps://example.invalid/a','["javascript:bad","https://example.invalid/b"]']) assert.throws(()=>parseUploadOutput(output,2), /count|partial|URL|failed/i);
});
test('upload boundary passes paths as distinct argv then replaces only image nodes', async () => {
  const text = '![a](assets/a%20b.png) ![again](assets/a%20b.png) <img src="b.png" width="20"> `![a](b.png)`';
  let request: any;
  const result = await uploadImages({source:text,root:'/notes',executable:'/tools/upload',argumentsJSON:'["--label","a b"]',jobId:'upload-test',isCurrent:()=>true,run:async args=>{request=args;return {exitCode:0,stdout:'["https://example.invalid/a","https://example.invalid/b"]'};}});
  assert.deepEqual(request.arguments,['--label','a b','/notes/assets/a b.png','/notes/b.png']);
  assert.equal(request.executable,'/tools/upload'); assert.equal(request.directory,'/notes'); assert.equal(request.input,undefined);
  assert.equal(result, '![a](https://example.invalid/a) ![again](https://example.invalid/a) <img src="https://example.invalid/b" width="20"> `![a](b.png)`');
});
test('upload refuses stale revision, missing configuration, partial output and process failure', async () => {
  const base = {source:'![a](a.png)',root:'/notes',executable:'/tools/upload',argumentsJSON:'[]',jobId:'u',isCurrent:()=>true,run:async()=>({exitCode:0,stdout:'https://example.invalid/a'})};
  await assert.rejects(uploadImages({...base,executable:''}),/configure|executable/i);
  await assert.rejects(uploadImages({...base,isCurrent:()=>false}),/changed/);
  for(const result of [{exitCode:1,stderr:'failed',stdout:'https://example.invalid/a'},{exitCode:0,stdout:'[]'},{exitCode:0,stdout:'https://example.invalid/a',outputTruncated:true},{exitCode:0,stdout:'https://example.invalid/a',timedOut:true},{exitCode:0,stdout:'https://example.invalid/a',cancelled:true}]) await assert.rejects(uploadImages({...base,run:async()=>result}));
});
test('syntax conversion escapes text and conservatively rejects lossy HTML conversion', () => {
  assert.equal(convertImageSyntax('![a & b](a.png "hi") `![a](a.png)`','html'), '<img src="a.png" alt="a &amp; b" title="hi"> `![a](a.png)`');
  assert.equal(convertImageSyntax('<img src="a%20b.png" alt="A &amp; B" title="hi">','markdown'), '![A & B](a%20b.png "hi")');
  assert.throws(()=>convertImageSyntax('<img src="a.png" width="42">','markdown'),/attributes|preserve/);
});
test('relative syntax handles spaces, parents and file URL without rewriting remote or code', () => {
  assert.equal(relativeImageURLs('![a](file:///notes/assets/a%20b.png) <img src="/elsewhere/c.png"> `![a](/x.png)` ![x](https://example.invalid/x)','/notes'), '![a](assets/a%20b.png) <img src="../elsewhere/c.png"> `![a](/x.png)` ![x](https://example.invalid/x)');
});
test('literal hash and percent directories survive local image resolution in POSIX, drive and UNC roots',()=>{
  for(const root of ['/notes #1/100%','/C:/notes #1/100%','/UNC/server/share/notes #1/100%']){
    const source='![a](assets/a%20b.png?size=2#view)';
    assert.deepEqual(localImagePlan(source,root).paths,[root+'/assets/a b.png']);
    assert.equal(relativeImageURLs(source,root),source);
  }
});

import { JSDOM } from 'jsdom';
import { undo, redo } from '@codemirror/commands';
import { NativeClient, normalizeSnapshot } from '../client/bridge.ts';
import { DocumentEditor } from '../client/editor.ts';
import { mountApp } from '../client/app.ts';
const dom = new JSDOM('<!doctype html><html><body><div id="image-tests"></div></body></html>', { url: 'https://mori.local/', pretendToBeVisual: true });
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
function root() { const element = document.getElementById('image-tests')!; element.replaceChildren(); return element; }
const snapshot = { documentId: 'a', path: null, text: '한글\r\nhello😀', revision: 0, savedDigest: null, encoding: 'utf8', lineEnding: 'CRLF' };
function transport(handle: (message: any) => void) { (win as any).webkit = { messageHandlers: { native: { postMessage: handle } } }; }
function reply(id: number, result: unknown) { (win as any).__nativeReply({ id, ok: true, result }); }


const tick = () => new Promise(resolve=>setTimeout(resolve,0));
function regressionHost(handle?: (message:any)=>unknown) {
  const messages:any[]=[]; let next=0;
  transport(message=>{messages.push(message); const custom=handle?.(message); if(custom===false)return; queueMicrotask(()=>reply(message.id,custom ?? ({bootstrap:{settings:{language:"en",restoreUnsaved:false},recoveries:[]},createDocument:{...snapshot,documentId:message.method==='createDocument' && next++ ? 'b':'a',text:'A'},chooseDocument:{...snapshot,documentId:'b',path:'/b.md',text:'B'},settings:{language:"en"},checkpoint:{},closeDocument:{}} as any)[message.method] ?? {}));});
  return messages;
}
test('restored path-backed and empty recoveries remain dirty and require close consent',async()=>{
  for(const text of ['recovered','']) {
    regressionHost(message=>message.method==='bootstrap'?{settings:{language:"en",restoreUnsaved:false},recoveries:[{...snapshot,documentId:'recovery',path:'/original.md',text,revision:7,savedDigest:'disk'}]}:message.method==='restoreDocument'?{...snapshot,documentId:'recovery',path:'/original.md',text,revision:7,savedDigest:'disk'}:undefined);
    const app=await mountApp(root());try {
      await app.action('recoveries'); document.querySelector<HTMLButtonElement>('dialog .dialog-body button')!.click();await tick();
      assert.equal(app.documents.get('recovery')!.savedRevision,-1);assert.equal(document.querySelector('[data-save-state]')!.textContent,'Unsaved file changes · Draft kept');
      document.querySelector<HTMLButtonElement>('[data-document="recovery"] .close-tab')!.click();await tick();assert.match(document.querySelector('dialog h2')!.textContent!,/unsaved/);
    }finally{app.destroy();}
  }
});
test('conflict reload keeps a stable identity, clears queued checkpoints and establishes clean disk source',async()=>{
  const messages=regressionHost(message=>message.method==='saveAs'?false:message.method==='reloadDocument'?{...snapshot,documentId:'a',path:'/a.md',text:'disk',revision:2,savedDigest:'new'}:message.method==='openDocument'?{...snapshot,documentId:'reloaded',path:'/a.md',text:'disk',revision:0,savedDigest:'new'}:undefined);
  const app=await mountApp(root());try {
    Object.assign(app.documents.get('a')!,{path:'/a.md',savedDigest:'base'});app.editor.replace('edited');
    transport(message=>{messages.push(message);queueMicrotask(()=>message.method==='saveDocument'?(win as any).__nativeReply({id:message.id,ok:false,error:{code:'conflict',message:'disk changed'}}):reply(message.id,message.method==='reloadDocument'?{...snapshot,documentId:'a',path:'/a.md',text:'disk',revision:2,savedDigest:'new'}:{}));});
    await app.save(); [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Reload Disk')!.click();await tick();
    assert.equal(app.activeId,'a');assert.equal(app.documents.get('a')!.documentId,'a');assert.equal(app.editor.text(),'disk');assert.equal(app.documents.get('a')!.savedRevision,app.documents.get('a')!.revision);assert.equal(app.documents.size,1);assert.equal((app as any).checkpointTimers.size,0);
  }finally{app.destroy();}
});
test('delayed image insertion and plain paste reject tab or revision changes and preserve both sources',async()=>{
  for(const operation of ['insert-image','paste-plain']) for(const change of ['tab','edit']) {
    let pending:any;regressionHost(message=>{if(message.method===(operation==='insert-image'?'importImages':'clipboard')){pending=message;return false;}});
    const app=await mountApp(root());try {
      const result=app.action(operation);const rejected=assert.rejects(result,/changed|origin|stale/i);await tick();
      if(change==='tab')await app.action('open');else app.editor.replace('new edit');
      reply(pending.id,operation==='insert-image'?['/state/unsaved/assets/p.png']:{text:'PASTED'});await rejected;
      assert.equal(app.editor.text(),change==='tab'?'B':'new edit');assert.equal(app.documents.get('a')!.text,change==='tab'?'A':'new edit');
    }finally{app.destroy();}
  }
});
test('external tool replacement is disabled when its origin tab or revision changes',async()=>{
  let pending:any;regressionHost(message=>{if(message.method==='runTool'){pending=message;return false;}});const app=await mountApp(root());try{
    await app.action('run-tool');const executable=document.querySelector<HTMLInputElement>('dialog input')!;executable.value='/fixture/tool';[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Run')!.click();await tick();await app.action('open');
    reply(pending.id,{exitCode:0,stdout:'REPLACEMENT'});await tick();const replace=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Replace Document')!;
    assert.equal(replace.disabled,true);replace.click();assert.equal(app.editor.text(),'B');
  }finally{app.destroy();}
});
test('Save As conflicts offer destination retry and never force-save the original or a different tab',async()=>{
  const messages=regressionHost();const app=await mountApp(root());try{
    Object.assign(app.documents.get('a')!,{path:'/a.md',savedDigest:'disk'});
    transport(message=>{messages.push(message);queueMicrotask(()=>message.method==='saveAs'?(win as any).__nativeReply({id:message.id,ok:false,error:{code:'conflict',message:'destination exists'}}):reply(message.id,message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/b.md',text:'B'}:{}));});
    await app.save(true);assert.equal(messages.find(m=>m.method==='saveAs').args.force,false);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('dialog button')].some(b=>b.textContent==='Overwrite Disk'),false);
    await app.action('open');[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Choose Destination Again')!.click();await tick();
    const retry=messages.filter(m=>m.method==='saveAs').at(-1);assert.equal(retry.args.documentId,'a');assert.equal(messages.some(m=>m.method==='saveDocument'),false);
  }finally{app.destroy();}
});
test('uncorrelated native protocol failure rejects every pending request including interactive calls',async()=>{
  transport(()=>{});const client=new NativeClient(win as any);try {
    const a=client.call('saveAs'),b=client.call('importImages');let settled=0;const checks=[a,b].map(p=>p.then(()=>assert.fail('must reject'),e=>{assert.equal(e.code,'protocol');settled++;}));
    (win as any).__nativeReply({id:-1,ok:false,error:{code:'invalidRequest',message:'Malformed native request'}});await tick();assert.equal(settled,2);await Promise.all(checks);
  }finally{client.dispose();}
});
test('first Save As sends precise asset ranges and adopts published collision links as saved source',async()=>{
  const messages=regressionHost(message=>message.method==='importImages'?['/state/unsaved/assets/p.png']:message.method==='saveAs'?{...snapshot,documentId:'a',path:'/published/note.md',text:'![](assets/p-1.png)',revision:message.args.revision,savedDigest:'saved'}:undefined);
  const app=await mountApp(root());try{
    app.editor.replace('',{from:0,to:0});await app.action('insert-image');await app.save();
    const request=messages.find(m=>m.method==='saveAs').args;
    assert.equal(request.assetRoot,'/state/unsaved');assert.deepEqual(request.imageReferences,[{path:'/state/unsaved/assets/p.png',from:4,to:16,html:false,suffix:''}]);
    assert.equal(app.editor.text(),'![](assets/p-1.png)');assert.equal(app.documents.get('a')!.savedRevision,app.documents.get('a')!.revision);
    app.setMode('reading');await tick();assert.ok(messages.some(m=>m.method==='readAsset'&&m.args.path==='/published/assets/p-1.png'));
  }finally{app.destroy();}
});
test('local image insertion escapes reserved filename characters as literal path segments',async()=>{
  const path='/state/unsaved/assets/a#b%?.png';
  const messages=regressionHost(message=>message.method==='bootstrap'?{settings:{language:"en",restoreUnsaved:false},recoveries:[],unsavedAssetRoot:'/state/unsaved'}:message.method==='importImages'?[path]:message.method==='readAsset'?{type:'image/png',base64:'AA=='}:undefined);
  const app=await mountApp(root());
  try{
    app.editor.replace('',{from:0,to:0});await app.action('insert-image');assert.equal(app.editor.text(),'![](assets/a%23b%25%3F.png)');
    app.setMode('reading');await tick();assert.equal(document.querySelector<HTMLImageElement>('.reading img')?.dataset.assetPath,path);
  }finally{app.destroy();}
});
test('image previews and Save As preserve literal directory characters through the native consumer',async()=>{
  for(const assetRoot of ['/notes #1/100%','/C:/notes #1/100%','/UNC/server/share/notes #1/100%']){
    const source='![a](assets/a%20b.png?size=2#view)\n\nend',path=assetRoot+'/assets/a b.png';
    const messages=regressionHost(message=>message.method==='chooseDocument'?{...snapshot,documentId:'special',path:assetRoot+'/note.md',text:source,savedDigest:'disk'}:message.method==='readAsset'?{type:'image/png',base64:'AA=='}:message.method==='saveAs'?{...snapshot,documentId:'special',path:assetRoot+'/copy.md',text:source,revision:message.args.revision,savedDigest:'disk'}:undefined);
    const app=await mountApp(root());
    try{
      await app.action('open');app.setMode('reading');await tick();
      assert.equal(document.querySelector<HTMLImageElement>('.reading img')?.dataset.assetPath,path);
      assert.equal(document.querySelector<HTMLImageElement>('.reading img')?.getAttribute('src'),'data:image/png;base64,AA==');
      await app.save(true);const request=messages.filter(message=>message.method==='saveAs').at(-1);
      assert.equal(request.args.assetRoot,assetRoot);assert.equal(request.args.imageReferences[0].path,path);assert.equal(request.args.imageReferences[0].suffix,'?size=2#view');
    }finally{app.destroy();}
  }
});
test('cancel acknowledgement applies only to the targeted job and never reports success after commit',async()=>{
  for(const acknowledged of [false,true]){
    const messages=regressionHost(message=>message.method==='cancelTool'?{cancelled:acknowledged}:undefined);const app=await mountApp(root());try{
      (app as any).exportJob='export-owned';(app as any).searchJob='search-owned';await app.action('cancel-job');
      assert.equal(messages.find(m=>m.method==='cancelTool').args.jobId,'export-owned');assert.equal((app as any).searchJob,'search-owned');
      if(!acknowledged){assert.equal((app as any).exportJob,'export-owned');assert.doesNotMatch(document.querySelector('[data-message]')!.textContent!,/^Cancelled/);}
    }finally{app.destroy();}
  }
});
test('image uploader settings and selected/all menus drive the actual argv native boundary and one undo',async()=>{
  const messages=regressionHost(message=>message.method==='bootstrap'?{settings:{language:"en",imageUploaderPath:'/fixture/upload',imageUploaderArguments:'["--label","literal space"]',customSource:'keep-unknown'},recoveries:[]}:message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/notes/n.md',text:'![a](a.png) ![b](b.png) `![c](c.png)`'}:message.method==='runTool'?{exitCode:0,stdout:'https://example.invalid/a\nhttps://example.invalid/b'}:undefined);
  const app=await mountApp(root());try{
    await app.action('open');assert.ok(document.querySelector('[data-action="upload-images"]'));assert.ok(document.querySelector('[data-action="upload-selected-image"]'));
    await app.action('upload-images');assert.equal(app.editor.text(),'![a](https://example.invalid/a) ![b](https://example.invalid/b) `![c](c.png)`');
    assert.deepEqual(messages.find(m=>m.method==='runTool').args.arguments,['--label','literal space','/notes/a.png','/notes/b.png']);undo(app.editor.view);assert.equal(app.editor.text(),'![a](a.png) ![b](b.png) `![c](c.png)`');
    await app.action('settings');assert.ok(document.querySelector('[data-setting="imageUploaderPath"]'));assert.ok(document.querySelector('[data-setting="imageUploaderArguments"]'));assert.equal((app.preferences as any).customSource,'keep-unknown');
  }finally{app.destroy();}
});
test('image syntax and reload menu consumers preserve source history and do not alter code samples',async()=>{
  regressionHost();const app=await mountApp(root());try{
    app.editor.replace('![a](a.png) `![a](a.png)`');await app.action('images-to-html');assert.equal(app.editor.text(),'<img src="a.png" alt="a"> `![a](a.png)`');undo(app.editor.view);assert.equal(app.editor.text(),'![a](a.png) `![a](a.png)`');
    const revision=app.documents.get(app.activeId)!.revision;await app.action('reload-images');assert.equal(app.documents.get(app.activeId)!.revision,revision);assert.equal(app.editor.text(),'![a](a.png) `![a](a.png)`');
  }finally{app.destroy();}
});
test('bootstrap restores saved tabs, active path and workspace without adding a blank document',async()=>{
  const messages=regressionHost(message=>message.method==='bootstrap'?{settings:{language:"en",session:{paths:['/notes/a.md','/notes/b.md'],activePath:'/notes/a.md',workspace:'/notes'},recentFiles:['/old.md']},recoveries:[]}:message.method==='openDocument'?{...snapshot,documentId:message.args.path,text:message.args.path,path:message.args.path,savedDigest:'disk'}:message.method==='listDirectory'?[]:undefined);
  const app=await mountApp(root());try{
    assert.equal(app.documents.size,2);assert.equal(app.documents.get(app.activeId)!.path,'/notes/a.md');assert.equal(app.workspace,'/notes');assert.equal(messages.some(m=>m.method==='createDocument'),false);
    await app.prepareForClose();const session=messages.filter(m=>m.method==='settings').at(-1).args.values.session;assert.deepEqual(session,{paths:['/notes/a.md','/notes/b.md'],activePath:'/notes/a.md',workspace:'/notes',documents:[{documentId:'/notes/a.md',path:'/notes/a.md'},{documentId:'/notes/b.md',path:'/notes/b.md'}],activeDocumentId:'/notes/a.md',views:{'/notes/a.md':{anchor:0,head:0,scroll:0},'/notes/b.md':{anchor:0,head:0,scroll:0}}});
    await app.action('quick-open');assert.ok([...document.querySelectorAll<HTMLButtonElement>('dialog button')].some(button=>button.title==='/old.md'));
  }finally{app.destroy();}
});
test('document Rename and Trash dialogs use the captured native document binding and require consent',async()=>{
  const messages=regressionHost(message=>message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/notes/old.md',text:'saved',savedDigest:'disk'}:message.method==='manageFile'?{path:message.args.destination ?? '/trash/old.md',document:{...snapshot,documentId:'b',path:message.args.operation==='trash'?null:message.args.destination,text:'saved',savedDigest:'disk'}}:undefined);
  const app=await mountApp(root());try{
    await app.action('open');await app.action('document-files');[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Rename File')!.click();
    document.querySelector<HTMLInputElement>('dialog input')!.value='new.md';[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Rename File')!.click();await tick();await tick();
    assert.equal(app.documents.get('b')!.path,'/notes/new.md');assert.deepEqual(messages.find(m=>m.method==='manageFile').args,{operation:'rename',documentId:'b',path:'/notes/old.md',destination:'/notes/new.md'});
    await app.action('document-files');[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Move to Trash')!.click();assert.equal(messages.filter(m=>m.method==='manageFile').length,1);
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Move to Trash')!.click();await tick();await tick();assert.equal(app.documents.has('b'),false);assert.equal(messages.filter(m=>m.method==='manageFile').at(-1).args.path,'/notes/new.md');
  }finally{app.destroy();}
});
test('math settings expose real numbering and physics consumers and persist the selected values',async()=>{
  const messages=regressionHost();const app=await mountApp(root());try{
    await app.action('settings');const numbering=document.querySelector<HTMLSelectElement>('[data-setting="mathNumbering"]'),physics=document.querySelector<HTMLInputElement>('[data-setting="mathPhysics"]');assert.ok(numbering);assert.ok(physics);
    numbering.value='ams';numbering.dispatchEvent(new Event('change',{bubbles:true}));physics.checked=true;physics.dispatchEvent(new Event('change',{bubbles:true}));await tick();
    const settings=messages.filter(m=>m.method==='settings').at(-1).args.values;assert.equal(settings.mathNumbering,'ams');assert.equal(settings.mathPhysics,true);assert.deepEqual((app as any).previewOptions(snapshot),{dark:false,documentId:'a',documentSource:'한글\r\nhello😀',numbering:'ams',physics:true});
  }finally{app.destroy();}
});
test('partial uploader errors expressed as strings never replace source',()=>{
  assert.throws(()=>parseUploadOutput('{"urls":["https://example.invalid/a"],"errors":"second file failed"}',1),/partial|failed/);
});
test('edits made while Save As publishes assets remain dirty and queued for recovery',async()=>{
  let saveRequest:any;regressionHost(message=>message.method==='importImages'?['/state/unsaved/assets/p.png']:message.method==='saveAs'?(saveRequest=message,false):undefined);
  const app=await mountApp(root());try{
    app.editor.replace('',{from:0,to:0});await app.action('insert-image');const pending=app.save();await tick();app.editor.replace(app.editor.text()+' later edit');
    reply(saveRequest.id,{...snapshot,documentId:'a',path:'/published/note.md',text:'![](assets/p-1.png)',revision:saveRequest.args.revision,savedDigest:'saved'});await pending;
    assert.equal(app.editor.text(),'![](assets/p-1.png) later edit');assert.notEqual(app.documents.get('a')!.savedRevision,app.documents.get('a')!.revision);assert.equal((app as any).checkpointTimers.has('a'),true);
  }finally{app.destroy();}
});
test('duplicate asset references preserve distinct URL fragments across Save As publication',async()=>{
  regressionHost(message=>message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/old/n.md',text:'![one](a.png#one) ![two](a.png#two)',savedDigest:'disk'}:message.method==='saveAs'?{...snapshot,documentId:'b',path:'/new/n.md',text:'![one](assets/a.png#one) ![two](assets/a.png#two)',revision:message.args.revision,savedDigest:'saved'}:undefined);
  const app=await mountApp(root());try{await app.action('open');await app.save(true);assert.equal(app.editor.text(),'![one](assets/a.png#one) ![two](assets/a.png#two)');}finally{app.destroy();}
});
test('finishing one export keeps Cancel available for a concurrently running tool',async()=>{
  let toolRequest:any,exportRequest:any;regressionHost(message=>{if(message.method==='runTool'){toolRequest=message;return false;}if(message.method==='export'){exportRequest=message;return false;}});
  const app=await mountApp(root());try{
    await app.action('run-tool');document.querySelector<HTMLInputElement>('dialog input')!.value='/fixture/tool';[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Run')!.click();await tick();
    const exporting=app.export('md');await tick();reply(exportRequest.id,{path:'/out.md'});await exporting;
    assert.equal(document.querySelector<HTMLButtonElement>('[data-action="cancel-job"]')!.hidden,false);
    reply(toolRequest.id,{exitCode:0,stdout:'output'});await tick();
  }finally{app.destroy();}
});

function imageFS(initial:Record<string,string>){
  const files=new Map(Object.entries(initial)),requests:any[]=[];
  const call=async(method:string,args:any):Promise<any>=>{
    requests.push({method,args});if(method==='listDirectory')return [...files.keys()].filter(path=>parent(path)===args.path).map(path=>({name:path.split('/').at(-1),path,isDirectory:false}));
    if(method!=='manageFile')throw new Error('unexpected method');const {operation,path,destination}=args;
    if(destination && files.has(destination))throw new Error('collision');if(!files.has(path))throw new Error('missing source');
    if(operation==='copy'){files.set(destination,files.get(path)!);return destination;}
    if(operation==='move'||operation==='rename'){files.set(destination,files.get(path)!);files.delete(path);return destination;}
    if(operation==='trash'){const trash='/trash/'+path.split('/').at(-1);files.set(trash,files.get(path)!);files.delete(path);return trash;}
    throw new Error('unexpected operation');
  };return {files,requests,call};
}
const parent=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/';
test('image file planner rejects destination escapes and duplicate target filenames before mutation',()=>{
  assert.throws(()=>planImageFileOperation('![a](a.png)','/notes','move','/outside'),/root|inside/);
  assert.throws(()=>planImageFileOperation('![a](one/a.png) ![b](two/a.png)','/notes','copy','/notes/assets'),/collision/);
  const text='![a](a.png) ![again](a.png)';assert.deepEqual(planImageFileOperation(text,'/notes','rename','/notes/new.png',{from:2,to:2}).files,[{path:'/notes/a.png',destination:'/notes/new.png'}]);
});
test('bulk image copy keeps originals and rewrites only image URLs including HTML attributes',async()=>{
  const fs=imageFS({'/notes/a.png':'A','/notes/b b.png':'B'}),text='![a](a.png#one) <img src="b%20b.png" width="20"> `![a](a.png)`';
  const changed=await manageImageFiles({source:text,root:'/notes',operation:'copy',destination:'/notes/assets',isCurrent:()=>true,call:fs.call});
  assert.equal(changed,'![a](assets/a.png#one) <img src="assets/b%20b.png" width="20"> `![a](a.png)`');assert.equal(fs.files.get('/notes/assets/a.png'),'A');assert.equal(fs.files.get('/notes/a.png'),'A');
});
test('image move rolls back all completed filesystem changes when source becomes stale',async()=>{
  const fs=imageFS({'/notes/a.png':'A','/notes/b.png':'B'});let current=true;
  const call=async(method:string,args:any)=>{const value=await fs.call(method,args);if(method==='manageFile'&&args.operation==='move'&&args.path==='/notes/a.png')current=false;return value;};
  await assert.rejects(manageImageFiles({source:'![a](a.png) ![b](b.png)',root:'/notes',operation:'move',destination:'/notes/assets',isCurrent:()=>current,call}),/changed/);
  assert.deepEqual([...fs.files].sort(),[['/notes/a.png','A'],['/notes/b.png','B']]);
});
test('image collisions abort before a batch and selected trash removes all corresponding image markup',async()=>{
  const fs=imageFS({'/notes/a.png':'A','/notes/assets/a.png':'occupied'});
  await assert.rejects(manageImageFiles({source:'![a](a.png)',root:'/notes',operation:'copy',destination:'/notes/assets',isCurrent:()=>true,call:fs.call}),/collision/i);assert.equal(fs.requests.filter(r=>r.method==='manageFile').length,0);
  const text='![a](a.png) <img src="a.png" alt="same"> `![a](a.png)`';
  assert.equal(await manageImageFiles({source:text,root:'/notes',operation:'trash',selection:{from:2,to:2},isCurrent:()=>true,call:fs.call}),'  `![a](a.png)`');assert.equal(fs.files.has('/notes/a.png'),false);assert.equal(fs.files.get('/trash/a.png'),'A');
});
test('actual image file dialog requires confirmation then renames links in one undo transaction',async()=>{
  const fs=imageFS({'/notes/a.png':'A'});const messages=regressionHost(message=>message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/notes/n.md',text:'![a](a.png) ![same](a.png)',savedDigest:'disk'}:message.method==='listDirectory'?[]:message.method==='manageFile'?false:undefined);
  const app=await mountApp(root());try{
    await app.action('open');app.editor.select({from:2,to:2});await app.action('rename-image');assert.equal(messages.some(m=>m.method==='manageFile'),false);
    const input=document.querySelector<HTMLInputElement>('[data-image-destination]')!;input.value='renamed.png';
    transport(message=>{messages.push(message);if(['setWindowTitle','settings','checkpoint'].includes(message.method)){reply(message.id,{});return;}void fs.call(message.method,message.args).then(value=>reply(message.id,value)).catch(error=>(win as any).__nativeReply({id:message.id,ok:false,error:{code:'fixture',message:error.message}}));});
    document.querySelector<HTMLButtonElement>('[data-action="image-file-apply"]')!.click();await tick();await tick();
    assert.equal(app.editor.text(),'![a](renamed.png) ![same](renamed.png)');undo(app.editor.view);assert.equal(app.editor.text(),'![a](a.png) ![same](a.png)');assert.equal(fs.files.get('/notes/renamed.png'),'A');
  }finally{app.destroy();}
});
test('encoding UI changes only originating document format, keeps source history, and queues dirty recovery',async()=>{
  const messages=regressionHost(message=>message.method==='chooseDocument'?{...snapshot,documentId:'b',path:'/notes/n.md',text:'한글\r\nsource',savedDigest:'disk'}:message.method==='setDocumentFormat'?{...snapshot,documentId:message.args.documentId,path:'/notes/n.md',text:message.args.text,revision:message.args.revision,encoding:message.args.encoding,savedDigest:'disk'}:undefined);
  const app=await mountApp(root());try{
    await app.action('open');const control=document.querySelector<HTMLSelectElement>('[data-control="encoding"]');assert.ok(control);control.value='utf16be';control.dispatchEvent(new Event('change',{bubbles:true}));await tick();
    const request=messages.find(m=>m.method==='setDocumentFormat').args;assert.deepEqual(request,{documentId:'b',text:'한글\r\nsource',revision:1,encoding:'utf16be'});
    assert.equal(app.editor.text(),'한글\r\nsource');assert.equal(app.documents.get('b')!.encoding,'utf16be');assert.equal(app.documents.get('b')!.revision,1);assert.equal(app.documents.get('b')!.savedRevision,0);assert.equal((app as any).checkpointTimers.has('b'),true);assert.equal(messages.some(m=>m.method==='saveDocument'||m.method==='saveAs'),false);
  }finally{app.destroy();}
});
test('a delayed encoding reply never changes another tab or overwrites newer source edits',async()=>{
  let pending:any;regressionHost(message=>message.method==='setDocumentFormat'?(pending=message,false):undefined);const app=await mountApp(root());try{
    const change=app.setEncoding('utf16le');await tick();app.editor.replace('newer edits');await app.action('open');
    reply(pending.id,{...snapshot,text:'A',revision:1,encoding:'utf16le'});await change;
    assert.equal(app.editor.text(),'B');assert.equal(app.documents.get('a')!.text,'newer edits');assert.equal(app.documents.get('a')!.encoding,'utf16le');assert.equal(app.documents.get('b')!.encoding,'utf8');
  }finally{app.destroy();}
});
test('Pandoc export controls send literal native options and diagnostics remain visible',async()=>{
  const messages=regressionHost(message=>message.method==='export'?{path:'/output/n.docx',diagnostics:'Output file was created but post-command failed: fixture failure'}:undefined);const app=await mountApp(root());try{
    await app.action('export-options');const format=document.querySelector<HTMLSelectElement>('[data-export-format]')!;assert.ok(format);format.value='docx';format.dispatchEvent(new Event('change',{bubbles:true}));
    for(const [key,value] of Object.entries({template:'/files/template.doc',referenceDoc:'/files/reference.docx',css:'/files/style.css',extraArguments:'["--wrap=none","literal space"]',tocDepth:'4',postCommand:'/fixture/post',postArguments:'["${output}","literal $()"]'})){
      const control=document.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[data-export-option="${key}"]`)!;assert.ok(control,key);control.value=value;control.dispatchEvent(new Event('change',{bubbles:true}));
    }
    document.querySelector<HTMLButtonElement>('[data-action="export-apply"]')!.click();await tick();await tick();
    const request=messages.find(m=>m.method==='export').args;assert.equal(request.format,'docx');assert.equal(request.options.referenceDoc,'/files/reference.docx');assert.equal(request.options.template,'/files/template.doc');assert.equal(request.options.css,'/files/style.css');assert.deepEqual(request.options.extraArguments,['--wrap=none','literal space']);assert.equal(request.options.tocDepth,4);assert.deepEqual(request.options.postArguments,['${output}','literal $()']);assert.match(document.querySelector('[data-message]')!.textContent!,/file was created.*post-command failed/i);
    await app.action('repeat-export');assert.equal(messages.filter(m=>m.method==='export').at(-1).args.options.destination,'/output/n.docx');
  }finally{app.destroy();}
});
test('export preset rename and delete persist real changes and reject collisions',async()=>{
  regressionHost(message=>message.method==='bootstrap'?{settings:{language:"en",exportPresets:{first:{format:'docx',template:'/first'},taken:{format:'epub'}}},recoveries:[]}:undefined);const app=await mountApp(root());try{
    await app.action('export-options');const preset=document.querySelector<HTMLSelectElement>('[data-export-preset]')!;assert.ok(preset);preset.value='first';preset.dispatchEvent(new Event('change',{bubbles:true}));assert.equal(document.querySelector<HTMLSelectElement>('[data-export-format]')!.value,'docx');
    document.querySelector<HTMLButtonElement>('[data-action="rename-export-preset"]')!.click();await tick();document.querySelector<HTMLInputElement>('dialog input')!.value='renamed';[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Apply')!.click();await tick();assert.ok(app.preferences.exportPresets.renamed);assert.equal(Object.hasOwn(app.preferences.exportPresets,'first'),false);
    const renamed=document.querySelector<HTMLSelectElement>('[data-export-preset]')!;renamed.value='renamed';renamed.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector<HTMLButtonElement>('[data-action="delete-export-preset"]')!.click();assert.ok(app.preferences.exportPresets.renamed);document.querySelector<HTMLButtonElement>('[data-action="confirm-delete-preset"]')!.click();await tick();assert.equal(Object.hasOwn(app.preferences.exportPresets,'renamed'),false);
  }finally{app.destroy();}
});
test('default Pandoc exports omit empty optional file paths and invalid argv never reaches native export',async()=>{
  const messages=regressionHost(message=>message.method==='export'?{path:'/output/n.docx'}:undefined),app=await mountApp(root());try{
    await app.export('docx');const options=messages.find(m=>m.method==='export').args.options;for(const key of ['template','referenceDoc','css','postCommand'])assert.equal(Object.hasOwn(options,key),false,key);
    const before=messages.filter(m=>m.method==='export').length;await assert.rejects(app.export('docx',{extraArguments:'--unparsed'} as any),/string array/);assert.equal(messages.filter(m=>m.method==='export').length,before);
  }finally{app.destroy();}
});
test('bulk image moves may target the document root without escaping it',()=>{
  assert.deepEqual(planImageFileOperation('![a](assets/a.png)','/notes','move','/notes').files,[{path:'/notes/assets/a.png',destination:'/notes/a.png'}]);
});
test('untitled recovery reuses native unsaved image root before preview and first Save As',async()=>{
  const recovery={...snapshot,documentId:'recovered-images',path:null,text:'![saved asset](assets/p.png)',revision:7};
  const messages=regressionHost(message=>message.method==='bootstrap'?{settings:{language:'en',restoreUnsaved:false,mode:'reading'},recoveries:[recovery],unsavedAssetRoot:'/state/unsaved'}:message.method==='restoreDocument'?recovery:message.method==='readAsset'?{base64:'AA==',type:'image/png'}:message.method==='saveAs'?{...recovery,path:'/published/n.md',savedDigest:'saved'}:undefined);
  const app=await mountApp(root());try{
    await app.action('recoveries');document.querySelector<HTMLButtonElement>('dialog .dialog-body button')!.click();await tick();await tick();
    assert.ok(messages.some(m=>m.method==='readAsset'&&m.args.root==='/state/unsaved'&&m.args.path==='/state/unsaved/assets/p.png'));
    await app.save();const request=messages.find(m=>m.method==='saveAs').args;assert.equal(request.assetRoot,'/state/unsaved');assert.equal(request.imageReferences[0].path,'/state/unsaved/assets/p.png');
  }finally{app.destroy();}
});
test('cancelling only a post-command reports the already-created output path',async()=>{
  regressionHost(message=>message.method==='cancelTool'?{cancelled:true,outputCreated:true,path:'/output/created.pdf'}:undefined);const app=await mountApp(root());try{
    (app as any).exportJob='post-owned';await app.action('cancel-job');const status=document.querySelector('[data-message]')!.textContent!;assert.match(status,/already created.*\/output\/created\.pdf/i);assert.doesNotMatch(status,/whole export.*cancelled/i);
  }finally{app.destroy();}
});
