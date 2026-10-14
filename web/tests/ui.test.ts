import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { undo, redo } from '@codemirror/commands';
import { NativeClient, normalizeSnapshot } from '../client/bridge.ts';
import { DocumentEditor } from '../client/editor.ts';
import { mountApp } from '../client/app.ts';
import { promptValue } from '../client/dialog.ts';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://mori.local/', pretendToBeVisual: true });
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
function root() { const element = document.getElementById('app')!; element.replaceChildren(); return element; }
const snapshot = { documentId: 'a', path: null, text: '한글\r\nhello😀', revision: 0, savedDigest: null, encoding: 'utf8', lineEnding: 'CRLF' };
test('editor preference consumers retain tab size and spellcheck across tabs',()=>{
  const editor=new DocumentEditor(root());try{
    editor.configure({tabSize:8,spellcheck:false,pairing:false});editor.open(snapshot);
    assert.equal(editor.view.state.tabSize,8);assert.equal(editor.view.contentDOM.getAttribute('spellcheck'),'false');
    editor.open({...snapshot,documentId:'prefs-b'});assert.equal(editor.view.state.tabSize,8);
  }finally{editor.destroy();}
});
test('editor paste routes rich clipboard content to its consumer',()=>{
  let received='';const editor=new DocumentEditor(root(),{onPaste:event=>{received=event.type;return true;}});
  try{editor.open(snapshot);const event=new win.Event('paste',{bubbles:true,cancelable:true});editor.view.contentDOM.dispatchEvent(event);assert.equal(received,'paste');assert.equal(event.defaultPrevented,true);assert.equal(editor.text(),snapshot.text);}finally{editor.destroy();}
});
function transport(handle: (message: any) => void) { (win as any).webkit = { messageHandlers: { native: { postMessage: handle } } }; }
function reply(id: number, result: unknown) { (win as any).__nativeReply({ id, ok: true, result }); }

test('native snapshot normalizes omitted nullable fields and preserves source', () => assert.deepEqual(normalizeSnapshot({ documentId: 'a', text: '', revision: 0, encoding: 'utf8', lineEnding: 'LF' }), { documentId: 'a', text: '', revision: 0, encoding: 'utf8', lineEnding: 'LF', path: null, savedDigest: null }));
test('native bridge sends exact asynchronous envelope and accepts replies', async () => {
  const messages: any[] = []; transport(message => messages.push(message));
  const client = new NativeClient(win as any);
  try { const pending = client.call('openDocument', { path: '/x.md' }); assert.deepEqual(messages, [{ id: 1, method: 'openDocument', args: { path: '/x.md' } }]); reply(1, { text: 'hello' }); assert.deepEqual(await pending, { text: 'hello' }); } finally { client.dispose(); }
});
test('native bridge rejects malformed replies and typed host failures', async () => {
  transport(() => {}); const client = new NativeClient(win as any);
  try {
    const invalid = client.call('settings'); (win as any).__nativeReply({ id: 1, ok: 'yes', result: {} }); await assert.rejects(invalid, /Invalid native reply/);
    const failed = client.call('saveDocument'); (win as any).__nativeReply({ id: 2, ok: false, error: { code: 'conflict', message: 'Disk changed' } }); await assert.rejects(failed, /Disk changed/);
  } finally { client.dispose(); }
});
test('native bridge rejects unavailable host and malformed snapshot', async () => {
  delete (win as any).webkit; const client = new NativeClient(win as any);
  try { await assert.rejects(client.call('chooseDocument'), /Native host unavailable/); assert.throws(() => normalizeSnapshot({ text: 'x' }), /Invalid document snapshot/); } finally { client.dispose(); }
});
test('real CodeMirror source/live toggle preserves Unicode source selection and history', () => {
  const editor = new DocumentEditor(root());
  try {
    editor.open(snapshot); editor.view.dispatch({ changes: { from: 0, insert: 'X' }, selection: { anchor: 1 } });
    editor.mode('source'); editor.mode('live');
    assert.equal(editor.text(), 'X한글\r\nhello😀'); assert.deepEqual(editor.selection(), { from: 1, to: 1 });
    assert.equal(undo(editor.view), true); assert.equal(editor.text(), '한글\r\nhello😀');
    assert.equal(redo(editor.view), true); assert.equal(editor.text(), 'X한글\r\nhello😀');
  } finally { editor.destroy(); }
});
test('CodeMirror command consumes actual core and creates one undo transaction', () => {
  const editor = new DocumentEditor(root());
  try { editor.open({ ...snapshot, text: 'hello' }); editor.view.dispatch({ selection: { anchor: 0, head: 5 } }); editor.command({ type: 'bold' }); assert.equal(editor.text(), '**hello**'); assert.deepEqual(editor.selection(), { from: 2, to: 7 }); undo(editor.view); assert.equal(editor.text(), 'hello'); } finally { editor.destroy(); }
});
test('document tabs preserve separate CodeMirror state history and selection', () => {
  const editor = new DocumentEditor(root());
  try { editor.open({ ...snapshot, text: 'one' }); editor.view.dispatch({ changes: { from: 3, insert: '!' }, selection: { anchor: 4 } }); editor.open({ ...snapshot, documentId: 'b', text: 'two' }); editor.view.dispatch({ changes: { from: 3, insert: '?' } }); editor.open({ ...snapshot, text: 'one' }); assert.equal(editor.text(), 'one!'); assert.deepEqual(editor.selection(), { from: 4, to: 4 }); undo(editor.view); assert.equal(editor.text(), 'one'); editor.open({ ...snapshot, documentId: 'b', text: 'two' }); assert.equal(editor.text(), 'two?'); } finally { editor.destroy(); }
});
test('closing a document releases its editor session and stale history',()=>{
  const editor=new DocumentEditor(root());try{editor.open({...snapshot,text:'old'});editor.replace('unsaved');editor.close(snapshot.documentId);editor.open({...snapshot,text:'fresh from disk'});assert.equal(editor.text(),'fresh from disk');assert.equal(undo(editor.view),false);}finally{editor.destroy();}
});
test('code autoindent uses the embedded JavaScript grammar and preserves CRLF with one undo',()=>{
  const source='```js\r\nfunction demo() {\r\nconsole.log("한글");\r\n}\r\n```';
  const editor=new DocumentEditor(root());try{editor.open({...snapshot,text:source});editor.autoIndent(true);assert.equal(editor.text(),'```js\r\nfunction demo() {\r\n    console.log("한글");\r\n}\r\n```');undo(editor.view);assert.equal(editor.text(),source);}finally{editor.destroy();}
});
test('restored editor view clamps surrogate and CRLF boundaries while retaining source and history',()=>{
  const editor=new DocumentEditor(root());try{editor.open({...snapshot,text:'😀\r\ntext'});editor.restoreView({anchor:1,head:3,scroll:12});assert.deepEqual(editor.selection(),{from:0,to:2});assert.equal(editor.text(),'😀\r\ntext');assert.equal(editor.captureView(snapshot.documentId)?.scroll,12);assert.equal(undo(editor.view),false);}finally{editor.destroy();}
});
test('line ending control changes actual source and undo restores original mixed endings', () => {
  const editor = new DocumentEditor(root());
  try { editor.open({ ...snapshot, text: 'a\r\nb\nc' }); editor.setLineEnding('LF'); assert.equal(editor.text(), 'a\nb\nc'); undo(editor.view); assert.equal(editor.text(), 'a\r\nb\nc'); } finally { editor.destroy(); }
});
test('reading mode retains editor history and source', () => {
  const editor = new DocumentEditor(root());
  try { editor.open({ ...snapshot, text: '# Hello' }); editor.view.dispatch({ changes: { from: 7, insert: '!' } }); editor.mode('reading'); editor.mode('source'); assert.equal(editor.text(), '# Hello!'); undo(editor.view); assert.equal(editor.text(), '# Hello'); } finally { editor.destroy(); }
});
function hostFixture() {
  const messages: any[] = [];
  transport(message => { messages.push(message); queueMicrotask(() => {
    const results: Record<string, unknown> = { bootstrap: { settings: {language:"en"}, recoveries: [] }, settings: {language:"en"}, recoveries: [], createDocument: { ...snapshot, text: '# Notes' }, chooseDocument: { ...snapshot, documentId: 'b', path: '/notes.md', text: 'Opened' }, chooseWorkspace: '/workspace', listDirectory: [{ name: 'note.md', path: '/workspace/note.md', isDirectory: false }], saveDocument: { revision: message.args.revision, savedDigest: 'saved' }, saveAs: { revision: message.args.revision, savedDigest: 'saved', path: '/notes.md' }, checkpoint: {}, searchWorkspace: [], export: { path: '/out.html' } };
    reply(message.id, results[message.method] ?? {});
  }); });
  return messages;
}
test('document-first chrome keeps navigation optional and relocated document controls usable',async()=>{
  hostFixture();const element=root(),app=await mountApp(element);
  try{
    assert.equal(element.querySelector('.toolbar'),null);
    assert.equal((element.querySelector('.sidebar') as HTMLElement).hidden,true);
    assert.ok(element.querySelector('.sidebar .document-tabs [role="tab"][aria-selected="true"]'));
    assert.equal(element.querySelector('[data-action="sidebar"]')?.getAttribute('aria-expanded'),'false');
    await app.action('sidebar');assert.equal((element.querySelector('.sidebar') as HTMLElement).hidden,false);
    await app.action('sidebar');assert.equal((element.querySelector('.sidebar') as HTMLElement).hidden,true);
    const info=element.querySelector<HTMLDetailsElement>('.document-info')!;info.open=true;
    const eol=element.querySelector<HTMLSelectElement>('[data-control="line-ending"]')!;
    eol.value='LF';eol.dispatchEvent(new Event('change'));
    assert.equal(app.editor.lineEnding(),'LF');assert.equal(app.editor.text(),'# Notes');
    info.querySelector('summary')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    assert.equal(info.open,false);assert.equal(document.activeElement,info.querySelector('summary'));
  }finally{app.destroy();}
});
test('Korean settings have named categories and explanations while source text remains unchanged',async()=>{
  const messages:any[]=[];transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,message.method==='bootstrap'?{settings:{},recoveries:[]}:message.method==='createDocument'?{...snapshot,text:'# 문서'}:{}));});
  const element=root(),app=await mountApp(element);try{
    assert.equal(app.preferences.language,'ko');await app.action('settings');await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(element.querySelector('dialog h2')!.textContent,'설정');assert.equal(element.querySelectorAll('button[data-settings-category]').length,7);
    const tab=element.querySelector<HTMLButtonElement>('[data-settings-category="proofreading"]')!;tab.click();assert.equal(tab.getAttribute('aria-selected'),'true');assert.equal((element.querySelector('[data-settings-panel="general"]') as HTMLElement).hidden,true);
    assert.match(element.querySelector('[data-setting-hint="spellcheck"]')!.textContent!,/빨간 밑줄/);assert.match(element.querySelector('[data-setting-hint="grammarCheck"]')!.textContent!,/파란 밑줄/);
    assert.equal(app.editor.text(),'# 문서');assert.ok(messages.some(message=>message.method==='uiLanguage'&&message.args.language==='ko'));
  }finally{app.destroy();}
});
test('document theme selection changes presentation and persistence without adding a source undo step',async()=>{
  const messages=hostFixture(),element=root(),app=await mountApp(element);try{
    app.editor.replace('# Notes!');await app.action('themes');element.querySelector<HTMLButtonElement>('[data-theme-option="newsprint"]')!.click();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(element.dataset.documentTheme,'newsprint');assert.match(element.querySelector('[data-theme-css]')!.textContent!,/#f3f1e9/);assert.equal(messages.filter(m=>m.method==='settings').at(-1).args.values.documentTheme,'newsprint');
    assert.equal(undo(app.editor.view),true);assert.equal(app.editor.text(),'# Notes');
  }finally{app.destroy();}
});
test('quit keeps canonical drafts and session identity automatically without Save As or a close modal',async()=>{
  const messages=hostFixture(),element=root(),app=await mountApp(element);try{
    app.editor.replace('다음 실행 때 복원할 한글😀');app.editor.select({from:4,to:4});
    assert.equal(await app.prepareForClose('quit'),true);assert.equal(element.querySelector('dialog'),null);assert.equal(messages.some(m=>m.method==='saveAs'),false);
    const checkpoint=messages.filter(m=>m.method==='checkpoint').at(-1),keep=messages.find(m=>m.method==='keepRecovery'),session=messages.filter(m=>m.method==='settings').at(-1).args.values.session;
    assert.equal(checkpoint.args.text,'다음 실행 때 복원할 한글😀');assert.equal(keep.args.revision,app.documents.get('a')!.revision);assert.deepEqual(session.documents,[{documentId:'a',path:null}]);assert.equal(session.activeDocumentId,'a');assert.equal(session.views.a.head,4);assert.equal(session.draftRevisions.a,app.documents.get('a')!.revision);
  }finally{app.destroy();}
});
test('saving a kept draft clears draft metadata so the next launch treats its file as clean',async()=>{
  const messages=hostFixture(),app=await mountApp(root());try{
    app.editor.replace('saved draft');assert.equal(await app.prepareForClose('quit'),true);await app.save();
    const session=messages.filter(m=>m.method==='settings').at(-1).args.values.session;assert.equal(session.draftRevisions,undefined);assert.equal(app.documents.get('a')!.revision,app.documents.get('a')!.savedRevision);assert.match(document.querySelector('[data-save-state]')!.textContent!,/Saved/);
  }finally{app.destroy();}
});
test('English words within Korean prose use English correction suggestions instead of empty Korean guesses',async()=>{
  transport(message=>{queueMicrotask(()=>reply(message.id,message.method==='bootstrap'?{settings:{language:'ko'},recoveries:[]}:message.method==='createDocument'?{...snapshot,text:'한국어 teh'}:message.method==='proofread'?{issues:[{from:4,to:7,kind:'spelling',message:'Check',suggestions:message.args.language==='en'?['the']:[]}],languages:['ko','en'],language:message.args.language}:{}));});
  const app=await mountApp(root());try{const checked=await (app as any).checkProofreading('한국어 teh');assert.equal(checked.issues.length,1);assert.deepEqual(checked.issues[0].suggestions,['the']);}finally{app.destroy();}
});
test('locked editor rejects direct widget task mutations and direct document transactions',()=>{
  const editor=new DocumentEditor(root());try{
    const text='- [ ] retained task\n\nCursor here';editor.open({...snapshot,text,lineEnding:'LF'});editor.select({from:text.length,to:text.length});editor.setLocked(true);
    document.querySelector<HTMLInputElement>('[data-mori-task="true"]')!.click();editor.view.dispatch({changes:{from:0,insert:'lost'}});
    assert.equal(editor.text(),text);assert.equal(editor.view.state.doc.toString(),text);
    editor.setLocked(false);document.querySelector<HTMLInputElement>('[data-mori-task="true"]')!.click();assert.match(editor.text(),/^- \[x\]/);
  }finally{editor.destroy();}
});
test('a failed replacement document stays read-only until a real new document is adopted',async()=>{
  let creates=0;transport(message=>queueMicrotask(()=>{if(message.method==='createDocument'&&++creates===2){(win as any).__nativeReply({id:message.id,ok:false,error:{code:'io',message:'Failed create'}});return;}reply(message.id,message.method==='bootstrap'?{settings:{language:'en'},recoveries:[]}:message.method==='createDocument'?{...snapshot,documentId:creates===1?'a':'c',path:creates===1?'/saved.md':null,text:creates===1?'disk':'',savedDigest:creates===1?'digest':null}:{});}));
  const app=await mountApp(root());try{
    await assert.rejects(app.action('close-document'),/Failed create/);assert.equal(app.documents.size,0);assert.equal(app.editor.view.state.readOnly,true);
    app.editor.view.dispatch({changes:{from:0,insert:'untracked'}});assert.equal(app.editor.text(),'');
    await app.action('new');assert.equal(app.editor.view.state.readOnly,false);app.editor.replace('tracked');assert.equal(app.documents.get('c')!.text,'tracked');
  }finally{app.destroy();}
});
test('kept bound drafts remain discoverable and reopen their retained identity instead of old disk text',async()=>{
  let creates=0,retained:any;const messages:any[]=[];
  transport(message=>{messages.push(message);queueMicrotask(()=>{if(message.method==='checkpoint')retained={...snapshot,documentId:'a',path:'/saved.md',text:message.args.text,revision:message.args.revision,savedDigest:'baseline'};reply(message.id,message.method==='bootstrap'?{settings:{language:'en'},recoveries:[]}:message.method==='createDocument'?++creates===1?{...snapshot,path:'/saved.md',text:'disk',savedDigest:'baseline'}:{...snapshot,documentId:'c',text:''}:message.method==='restoreDocument'?retained:{});});});
  const app=await mountApp(root());try{
    app.editor.replace('retained edits');const close=app.action('close-document');await new Promise(resolve=>setTimeout(resolve,0));[...document.querySelectorAll<HTMLButtonElement>('dialog footer button')].find(button=>button.textContent==='Keep Draft')!.click();await close;
    await app.action('recoveries');assert.ok([...document.querySelectorAll('dialog .dialog-body button')].some(button=>button.textContent==='saved.md'));document.querySelector<HTMLButtonElement>('dialog header button')!.click();
    await app.action('reopen-closed');assert.equal(app.activeId,'a');assert.equal(app.editor.text(),'retained edits');assert.equal(app.documents.get('a')!.savedRevision,-1);assert.match(document.querySelector('[data-save-state]')!.textContent!,/Draft kept/);assert.equal(messages.some(message=>message.method==='openDocument'),false);
  }finally{app.destroy();}
});
test('startup restores ordered untitled and dirty file drafts by identity and preserves their active cursor',async()=>{
  const records=[{...snapshot,documentId:'draft',text:'새 임시 문서',revision:3},{...snapshot,documentId:'bound',path:'/notes.md',text:'원본과 다른 내용',revision:8,savedDigest:'old-digest'}];const messages:any[]=[];
  transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,message.method==='bootstrap'?{settings:{language:'ko',session:{paths:['/notes.md'],activePath:'/notes.md',workspace:null,documents:records.map(({documentId,path})=>({documentId,path})),activeDocumentId:'draft',draftRevisions:{draft:3,bound:8},views:{draft:{anchor:2,head:2,scroll:0}}}},recoveries:records}:message.method==='restoreDocument'?records.find(r=>r.documentId===message.args.documentId):{}));});
  const app=await mountApp(root());try{
    assert.deepEqual([...app.documents.keys()],['draft','bound']);assert.equal(app.activeId,'draft');assert.equal(app.editor.text(),'새 임시 문서');assert.equal(app.editor.selection().to,2);assert.equal(app.documents.get('bound')!.savedRevision,-1);assert.equal(app.documents.get('bound')!.savedDigest,'old-digest');assert.equal(messages.some(m=>m.method==='createDocument'||m.method==='saveDocument'),false);
  }finally{app.destroy();}
});
test('compact menu formatting closes the popover and source switch preserves undo history',async()=>{
  hostFixture();const element=root(),app=await mountApp(element);
  try{
    const menu=element.querySelector<HTMLDetailsElement>('.command-menu')!;menu.open=true;
    const format=element.querySelector<HTMLDetailsElement>('[data-menu="format"]')!;format.open=true;
    app.editor.select({from:2,to:7});element.querySelector<HTMLButtonElement>('[data-command="bold"]')!.click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(menu.open,false);assert.equal(format.open,false);assert.equal(app.editor.text(),'# **Notes**');
    element.querySelector<HTMLButtonElement>('[data-action="source"]')!.click();
    assert.equal(app.preferences.mode,'source');assert.equal(element.querySelector('[data-action="source"]')?.getAttribute('aria-pressed'),'true');
    element.querySelector<HTMLButtonElement>('[data-action="source"]')!.click();
    assert.equal(app.preferences.mode,'live');assert.equal(undo(app.editor.view),true);assert.equal(app.editor.text(),'# Notes');
  }finally{app.destroy();}
});
test('rich clipboard paste inserts real Markdown in one undo transaction',async()=>{
  hostFixture();const app=await mountApp(root());try{
    app.editor.select({from:0,to:7});const event=new win.Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{files:[],getData:(kind:string)=>kind==='text/html'?'<h2>붙여넣기</h2><p><strong>강조</strong></p>':''}});
    app.editor.view.contentDOM.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(event.defaultPrevented,true);assert.equal(app.editor.text(),'## 붙여넣기\r\n\r\n**강조**');undo(app.editor.view);assert.equal(app.editor.text(),'# Notes');
  }finally{app.destroy();}
});
test('image drops publish assets before one undoable Markdown insertion',async()=>{
  const messages:any[]=[];transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,message.method==='bootstrap'?{settings:{language:"en"},recoveries:[],unsavedAssetRoot:'/scratch/unsaved'}:message.method==='createDocument'?{...snapshot,text:''}:message.method==='importImages'?[{path:'/scratch/unsaved/assets/dropped.png'}]:message.method==='readAsset'?{type:'image/png',base64:'AA=='}:{}));});
  const app=await mountApp(root());try{
    const event=new win.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[{name:'dropped.png',type:'image/png',size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}]}});
    app.editor.view.contentDOM.dispatchEvent(event);await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(event.defaultPrevented,true);assert.equal(app.editor.text(),'![](assets/dropped.png)');assert.equal(messages.find(m=>m.method==='importImages').args.base64,'AQID');undo(app.editor.view);assert.equal(app.editor.text(),'');
  }finally{app.destroy();}
});
test('replacing a prompt resolves its cancellation instead of retaining a pending command',async()=>{
  const element=root();hostFixture();const app=await mountApp(element),pending=promptValue(element,'Link','URL');
  try{await app.action('settings');assert.equal(await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve('timeout'),30))]),null);}finally{app.destroy();}
});
test('settings CSS, pairing and tab controls reach the actual editor and reset',async()=>{
  hostFixture();const app=await mountApp(root());try{
    await app.action('settings');const css=document.querySelector('[data-setting="customCSS"]') as HTMLTextAreaElement;assert.ok(css);css.value='.markdown-body{color:purple}';css.dispatchEvent(new Event('change'));
    assert.equal(document.querySelector('[data-user-css]')?.textContent,'.markdown-body{color:purple}');
    const tab=document.querySelector('[data-setting="tabSize"]') as HTMLInputElement;tab.value='8';tab.dispatchEvent(new Event('change'));assert.equal(app.editor.view.state.tabSize,8);
    document.querySelector<HTMLButtonElement>('[data-action="reset-settings"]')!.click();assert.equal(app.editor.view.state.tabSize,4);assert.equal(document.querySelector('[data-user-css]')?.textContent,'');
  }finally{app.destroy();}
});
test('whole-document SVG passes complete HTML for measured native output',async()=>{
  const messages=hostFixture();const app=await mountApp(root());try{
    app.editor.replace('# Long document\n\nEND_OF_DOCUMENT');await app.export('svg');
    const request=messages.find(message=>message.method==='export');assert.match(request.args.content,/<!doctype html>/i);assert.match(request.args.content,/END_OF_DOCUMENT/);assert.doesNotMatch(request.args.content,/height="1400"/);
  }finally{app.destroy();}
});
test('window close checkpoints dirty text before explicit recovery consent',async()=>{
  const messages=hostFixture();const app=await mountApp(root());
  try{
    app.editor.replace('끝나기 직전 변경');const pending=app.prepareForClose();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(messages.some(m=>m.method==='checkpoint'&&m.args.text==='끝나기 직전 변경'));
    const keep=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Keep Recovery');
    assert.ok(keep);keep.click();assert.equal(await pending,true);
  }finally{app.destroy();}
});
test('automatic save is opt-in, saves its original background document and never creates an untitled destination',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const messages=hostFixture();const app=await mountApp(root());
  try{
    await app.action('open');app.editor.replace('background saved text');context.mock.timers.tick(1500);await Promise.resolve();
    assert.equal(messages.some(message=>message.method==='saveDocument'),false);
    await app.action('settings');const automatic=document.querySelector<HTMLInputElement>('[data-setting="autoSave"]')!;assert.ok(automatic);automatic.checked=true;automatic.dispatchEvent(new Event('change'));
    document.querySelector<HTMLButtonElement>('dialog header button')!.click();await app.action('new');app.editor.replace('untitled stays open');
    context.mock.timers.tick(1500);for(let i=0;i<8;i++)await Promise.resolve();
    const saved=messages.find(message=>message.method==='saveDocument');assert.ok(saved);assert.equal(saved.args.documentId,'b');assert.equal(saved.args.text,'background saved text');assert.equal(saved.args.force,false);
    assert.equal(app.editor.text(),'untitled stays open');assert.equal(messages.some(message=>message.method==='saveAs'),false);
  }finally{app.destroy();}
});
test('automatic save pauses on external conflict without opening a modal or forcing a write',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});const messages=hostFixture();const app=await mountApp(root());
  try{
    await app.action('open');transport(message=>{messages.push(message);queueMicrotask(()=>message.method==='saveDocument'?(win as any).__nativeReply({id:message.id,ok:false,error:{code:'conflict',message:'Disk changed'}}):reply(message.id,message.method==='observeDocument'?{status:'unchanged',diskDigest:'disk'}:{}));});
    await app.action('settings');const automatic=document.querySelector<HTMLInputElement>('[data-setting="autoSave"]')!;assert.ok(automatic);automatic.checked=true;automatic.dispatchEvent(new Event('change'));document.querySelector<HTMLButtonElement>('dialog header button')!.click();
    app.editor.replace('my current edits');context.mock.timers.tick(1500);for(let i=0;i<8;i++)await Promise.resolve();
    assert.equal(app.editor.text(),'my current edits');assert.equal(document.querySelector('dialog'),null);assert.match(document.querySelector('[data-message]')!.textContent!,/auto.*save.*paused/i);
    assert.notEqual(app.documents.get('b')!.revision,app.documents.get('b')!.savedRevision);assert.equal(messages.filter(message=>message.method==='saveDocument').length,1);
    context.mock.timers.tick(3000);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(messages.filter(message=>message.method==='saveDocument').length,1);
  }finally{app.destroy();}
});
test('external file observation reloads clean source and keeps dirty edits and missing files open',async()=>{
  const messages=hostFixture();const app=await mountApp(root());let state='modified';
  try{
    await app.action('open');transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,message.method==='observeDocument'?{status:state,diskDigest:'outside'}:message.method==='reloadDocument'?{...snapshot,documentId:'b',path:'/notes.md',text:'external\r\n새글😀',revision:message.args.revision,savedDigest:'outside',lineEnding:'CRLF'}:{}));});
    await app.action('check-files');assert.equal(app.editor.text(),'external\r\n새글😀');assert.equal(app.documents.get('b')!.revision,app.documents.get('b')!.savedRevision);
    app.editor.replace('keep my draft');await app.action('check-files');assert.equal(app.editor.text(),'keep my draft');assert.equal(messages.filter(message=>message.method==='reloadDocument').length,1);
    state='missing';await app.action('check-files');assert.equal(app.editor.text(),'keep my draft');assert.ok(app.documents.has('b'));assert.match(document.querySelector('[data-message]')!.textContent!,/missing|removed/i);
  }finally{app.destroy();}
});
for(const condition of ['dialog','composition'] as const)test(`automatic reload keeps source when ${condition} starts while the reply is pending`,async()=>{
  hostFixture();const app=await mountApp(root());let reload:any;
  try{
    await app.action('open');const digest=app.documents.get('b')!.savedDigest;
    transport(message=>{if(message.method==='reloadDocument'){reload=message;return;}queueMicrotask(()=>reply(message.id,message.method==='observeDocument'?{status:'modified',diskDigest:'outside'}:{}));});
    const work=app.action('check-files');for(let i=0;i<8;i++)await Promise.resolve();assert.ok(reload);
    if(condition==='dialog')await app.action('settings');else app.editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));
    reply(reload.id,{...snapshot,documentId:'b',path:'/notes.md',text:'outside\r\ntext',revision:reload.args.revision,savedDigest:'outside',lineEnding:'CRLF'});await work;
    assert.equal(app.editor.text(),'Opened');assert.equal(app.documents.get('b')!.savedDigest,digest);
    if(condition==='composition')app.editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));
  }finally{app.destroy();}
});
test('manual disk reload adopts the new line-ending mode for the next real editor transaction',async()=>{
  hostFixture();const app=await mountApp(root());
  try{
    transport(message=>queueMicrotask(()=>message.method==='chooseDocument'?reply(message.id,{...snapshot,documentId:'b',path:'/notes.md',text:'Before',lineEnding:'LF',savedDigest:'old'}):message.method==='saveDocument'?(win as any).__nativeReply({id:message.id,ok:false,error:{code:'conflict',message:'Disk changed'}}):reply(message.id,message.method==='reloadDocument'?{...snapshot,documentId:'b',path:'/notes.md',text:'A\r\nB',lineEnding:'CRLF',revision:message.args.revision,savedDigest:'new'}:{})));
    await app.action('open');await app.save();[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Reload Disk')!.click();await new Promise(resolve=>setTimeout(resolve,0));
    app.editor.view.dispatch({changes:{from:app.editor.view.state.doc.length,insert:'\nX'}});assert.equal(app.editor.text(),'A\r\nB\r\nX');
  }finally{app.destroy();}
});
test('overlapping saves serialize per document and use the acknowledged disk digest for the newer source',async()=>{
  const messages=hostFixture();const app=await mountApp(root());
  try{
    await app.action('open');app.documents.get('b')!.savedDigest='original';const pending:any[]=[];
    transport(message=>{messages.push(message);if(message.method==='saveDocument')pending.push(message);else queueMicrotask(()=>reply(message.id,{}));});
    app.editor.replace('first version');const first=app.save();app.editor.replace('latest version');const latest=app.save();
    assert.equal(pending.length,1);assert.equal(pending[0].args.text,'first version');reply(pending[0].id,{revision:pending[0].args.revision,savedDigest:'first-digest'});await first;await Promise.resolve();
    assert.equal(pending.length,2);assert.equal(pending[1].args.text,'latest version');assert.equal(pending[1].args.expectedDigest,'first-digest');
    reply(pending[1].id,{revision:pending[1].args.revision,savedDigest:'latest-digest'});await latest;
    assert.equal(app.editor.text(),'latest version');assert.equal(app.documents.get('b')!.revision,app.documents.get('b')!.savedRevision);assert.equal(document.querySelector('dialog'),null);
  }finally{app.destroy();}
});
test('window close cancellation leaves dirty editor source and history intact',async()=>{
  hostFixture();const app=await mountApp(root());
  try{
    app.editor.replace('취소해도 남는 내용');const pending=app.prepareForClose();
    await new Promise(resolve=>setTimeout(resolve,0));
    const cancel=[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Cancel');
    assert.ok(cancel);cancel.click();assert.equal(await pending,false);
    assert.equal(app.editor.text(),'취소해도 남는 내용');undo(app.editor.view);assert.equal(app.editor.text(),'# Notes');
  }finally{app.destroy();}
});
test('window close during IME composition keeps the editor open without checkpointing incomplete text',async()=>{
  const messages=hostFixture();const app=await mountApp(root());
  try{
    app.editor.replace('조합 중인 문장');
    app.editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart',{bubbles:true}));
    assert.equal(app.editor.view.compositionStarted,true);
    messages.length=0;
    const pending=app.prepareForClose();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(document.querySelector('dialog'),null);
    assert.equal(messages.some(message=>message.method==='checkpoint'),false);
    assert.equal(await pending,false);
    assert.equal(app.editor.text(),'조합 중인 문장');
    app.editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionend',{bubbles:true}));
  }finally{app.destroy();}
});
test('native close approval is invalidated by canonical commands and document membership changes',async()=>{
  const script=readFileSync(new URL('../../Sources/Mori/NativeCloseContract.swift',import.meta.url),'utf8').split('static let installScript = """')[1].split('"""')[0];
  vm.runInNewContext(script,{window:win});const close=(win as any).__moriNativeClose;
  hostFixture();const app=await mountApp(root());
  const accept=async()=>{const pending=close.prepare();await new Promise(resolve=>setTimeout(resolve,0));[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Keep Recovery')!.click();assert.equal(await pending,true);assert.equal(close.isCurrent(),true);};
  try{
    app.editor.replace('text',{from:0,to:4});await accept();
    (win as any).__nativeCommand({type:'bold'});await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(app.editor.text(),'**text**');assert.equal(close.isCurrent(),false);
    await accept();await app.action('undo');assert.equal(app.editor.text(),'text');assert.equal(close.isCurrent(),false);
    await accept();transport(message=>queueMicrotask(()=>reply(message.id,message.method==='createDocument'?{...snapshot,documentId:'new',text:''}:{})));await app.action('new');assert.equal(close.isCurrent(),false);
  }finally{app.destroy();}
});
test('Keep Recovery after a canonical edit checkpoints the latest source before close approval',async()=>{
  const messages=hostFixture();const app=await mountApp(root());
  try{
    app.editor.replace('text',{from:0,to:4});const pending=app.prepareForClose();await new Promise(resolve=>setTimeout(resolve,0));
    (win as any).__nativeCommand({type:'italic'});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(app.editor.text(),'*text*');
    [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='Keep Recovery')!.click();
    assert.equal(await pending,true);assert.equal(messages.filter(message=>message.method==='checkpoint').at(-1)?.args.text,'*text*');
  }finally{app.destroy();}
});
test('app bootstrap creates an actual editor and semantic controls', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { assert.equal(app.editor.text(), '# Notes'); assert.equal(document.querySelector('[data-action="save"]')?.textContent, 'Save'); assert.ok(document.querySelector('.cm-editor')); assert.ok(messages.some(message=>message.method==='bootstrap'));assert.ok(messages.some(message=>message.method==='createDocument')); } finally { app.destroy(); }
});
test('tab selection and edits synchronize native title, file URL and dirty state',async()=>{
  const messages=hostFixture(),app=await mountApp(root());try{
    await app.action('open');app.editor.replace('changed');await new Promise(resolve=>setTimeout(resolve,0));
    const opened=messages.filter(message=>message.method==='setWindowTitle').at(-1);assert.equal(opened?.args.path,'/notes.md');assert.equal(opened?.args.edited,true);
    await app.action('new');await new Promise(resolve=>setTimeout(resolve,0));
    const untitled=messages.filter(message=>message.method==='setWindowTitle').at(-1);assert.equal(untitled?.args.path,null);assert.equal(untitled?.args.title,'Untitled');
  }finally{app.destroy();}
});
test('folder sort and pin controls persist and affect the actual tree and quick open',async()=>{
  const messages:any[]=[];transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,message.method==='bootstrap'?{settings:{language:"en"},recoveries:[]}:message.method==='createDocument'?{...snapshot,text:''}:message.method==='chooseWorkspace'?'/workspace':message.method==='listDirectory'?[{name:'a.md',path:'/workspace/a.md',modified:1},{name:'b.md',path:'/workspace/b.md',modified:9}]:{}));});
  const app=await mountApp(root());try{await app.action('folder');await app.action('pin-folder');
    const sort=document.querySelector('[data-control="file-sort"]') as HTMLSelectElement;assert.ok(sort);sort.value='modified';sort.dispatchEvent(new Event('change'));await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual([...document.querySelectorAll('.file-tree [data-path]')].map(node=>node.textContent),['b.md','a.md']);
    assert.deepEqual(messages.filter(message=>message.method==='settings').at(-1)?.args.values.pinnedFolders,['/workspace']);
    await app.action('quick-open');assert.ok([...document.querySelectorAll('dialog button')].some(node=>node.textContent==='Pinned: workspace'));
  }finally{app.destroy();}
});
test('code-copy consumer excludes fence markers and retains literal Korean code',async()=>{
  const messages=hostFixture(),app=await mountApp(root());try{app.editor.replace('```js\r\nconsole.log("한글");\r\n```');app.editor.select({from:8,to:8});await app.action('copy-code');assert.equal(messages.find(message=>message.method==='clipboard')?.args.text,'console.log("한글");\r\n');}finally{app.destroy();}
});
test('actual DOM mode control preserves edits and undo', async () => {
  hostFixture(); const app = await mountApp(root());
  try { app.editor.view.dispatch({ changes: { from: 7, insert: '!' } }); const mode = document.querySelector('[data-control="mode"]') as HTMLSelectElement; mode.value = 'source'; mode.dispatchEvent(new Event('change', { bubbles: true })); mode.value = 'live'; mode.dispatchEvent(new Event('change', { bubbles: true })); assert.equal(app.editor.text(), '# Notes!'); undo(app.editor.view); assert.equal(app.editor.text(), '# Notes'); } finally { app.destroy(); }
});
test('save snapshots exact edited source and returned revision marks saved', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { app.editor.view.dispatch({ changes: { from: 7, insert: '😀' } }); await app.save(); const message = messages.find(message => message.method === 'saveAs'); assert.deepEqual(message.args, { documentId: 'a', text: '# Notes😀', revision: 1, force: false }); assert.equal(app.documents.get('a').savedRevision, 1); } finally { app.destroy(); }
});
test('DOM find/replace changes real editor source with literal results', async () => {
  hostFixture(); const app = await mountApp(root());
  try { await app.action('find'); const query = document.querySelector('[data-control="find"]') as HTMLInputElement; query.value = 'Notes'; query.dispatchEvent(new Event('input', { bubbles: true })); const replacement = document.querySelector('[data-control="replacement"]') as HTMLInputElement; replacement.value = 'Document'; document.querySelector<HTMLButtonElement>('[data-action="replace-all"]')!.click(); assert.equal(app.editor.text(), '# Document'); undo(app.editor.view); assert.equal(app.editor.text(), '# Notes'); } finally { app.destroy(); }
});
test('format menus expose every implemented command with real handlers', async () => {
  hostFixture(); const app = await mountApp(root());
  try { for (const command of ['bold','italic','underline','strike','highlight','code','sup','sub','comment','inlineMath','heading','quote','bullet','ordered','task','toggleTask','indent','outdent','horizontalRule','codeBlock','mathBlock','toc','yaml','alert','link','image','clearFormat','insertParagraphBefore','insertParagraphAfter','moveLineUp','moveLineDown','deleteBlock','deleteWord']) assert.ok(document.querySelector(`[data-command="${command}"]`), command); } finally { app.destroy(); }
});
test('table modal edits semantic cells and commits a single real editor transaction', async () => {
  hostFixture(); const app = await mountApp(root());
  try { app.editor.replace('', { from: 0, to: 0 }); await app.action('table'); const cell = document.querySelector('[data-cell-row="-1"][data-cell-col="0"]') as HTMLInputElement; cell.value = 'A'; cell.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector<HTMLButtonElement>('[data-action="table-apply"]')!.click(); assert.equal(app.editor.text(), '| A |  |\n| --- | --- |\n|  |  |\n|  |  |'); undo(app.editor.view); assert.equal(app.editor.text(), ''); } finally { app.destroy(); }
});
test('settings change typography and persist exact consumer values', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { await app.action('settings'); const size = document.querySelector('[data-setting="fontSize"]') as HTMLInputElement; size.value = '24'; size.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(document.getElementById('app')!.style.getPropertyValue('--font-size'), '24px'); assert.equal(messages.findLast(message => message.method === 'settings').args.values.fontSize, 24); } finally { app.destroy(); }
});
test('folder action reads actual native directory and renders file destination', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { await app.action('folder'); assert.ok(document.querySelector('[data-path="/workspace/note.md"]')); assert.deepEqual(messages.find(message => message.method === 'listDirectory').args, { path: '/workspace' }); } finally { app.destroy(); }
});
test('outline navigation selects the original source heading', async () => {
  hostFixture(); const app = await mountApp(root());
  try { await app.action('outline'); document.querySelector<HTMLButtonElement>('[data-outline-from="0"]')!.click(); assert.deepEqual(app.editor.selection(), { from: 0, to: 7 }); } finally { app.destroy(); }
});
test('native formatting commands consume real source and history', async () => {
  hostFixture(); const app = await mountApp(root());
  try { app.editor.view.dispatch({ selection: { anchor: 2, head: 7 } }); (win as any).__nativeCommand({ type: 'bold' }); assert.equal(app.editor.text(), '# **Notes**'); undo(app.editor.view); assert.equal(app.editor.text(), '# Notes'); } finally { app.destroy(); }
});
test('late save cannot mark a later document revision as saved', async () => {
  hostFixture(); const app = await mountApp(root()); let saveMessage: any;
  try { transport(message => { if (message.method === 'saveAs') saveMessage = message; else queueMicrotask(() => reply(message.id, {})); }); app.editor.replace('# first'); const save = app.save(); app.editor.replace('# second'); reply(saveMessage.id, { revision: 1, savedDigest: 'first', path: '/a.md' }); await save; assert.equal(app.documents.get('a').revision, 2); assert.equal(app.documents.get('a').savedRevision, 1); assert.equal(document.querySelector('[data-document="a"]')?.getAttribute('data-dirty'), 'true'); } finally { app.destroy(); }
});
test('copy Markdown uses native clipboard with exact original bytes', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { app.editor.replace('**한글**\r\n😀'); await app.action('copy-markdown'); assert.deepEqual(messages.findLast(message => message.method === 'clipboard').args, { operation: 'write', text: '**한글**\r\n😀' }); } finally { app.destroy(); }
});
test('HTML export calls the real renderer and native immutable snapshot contract', async () => {
  const messages = hostFixture(); const app = await mountApp(root());
  try { await app.export('html'); const message = messages.find(message => message.method === 'export'); assert.equal(message.args.format, 'html'); assert.ok(message.args.content.includes('<h1 id="notes">Notes</h1>')); assert.equal(message.args.filename, 'Notes.html'); assert.equal(message.args.documentPath, null); } finally { app.destroy(); }
});
test('UI invalid regex shows an actionable error without changing source', async () => {
  hostFixture(); const app = await mountApp(root());
  try { await app.action('find'); const regex = document.querySelector('[data-control="regex"]') as HTMLInputElement; regex.checked = true; regex.dispatchEvent(new Event('change', { bubbles: true })); const query = document.querySelector('[data-control="find"]') as HTMLInputElement; query.value = '['; query.dispatchEvent(new Event('input', { bubbles: true })); assert.match(document.querySelector('[data-search-status]')!.textContent!, /Invalid|regular expression/i); assert.equal(app.editor.text(), '# Notes'); } finally { app.destroy(); }
});
test('live task checkbox changes the canonical source and is undoable', async () => {
  hostFixture(); const app = await mountApp(root());
  try { app.editor.replace('- [ ] one\n\nend', { from: 12, to: 12 }); app.editor.mode('source'); app.editor.mode('live'); const checkbox = document.querySelector<HTMLInputElement>('.live-block input[type="checkbox"]'); assert.ok(checkbox); checkbox.click(); assert.equal(app.editor.text(), '- [x] one\n\nend'); undo(app.editor.view); assert.equal(app.editor.text(), '- [ ] one\n\nend'); } finally { app.destroy(); }
});
test('raw HTML checkboxes cannot edit later tasks or displace actual list task controls',()=>{
  for(const source of ['<input class="task-list-item-checkbox" type="checkbox">\r\n\r\n- [ ] later\r\n\r\nend','- <input class="task-list-item-checkbox" type="checkbox">\n- [ ] later\n\nend']){
    const editor=new DocumentEditor(root());try{editor.open({...snapshot,text:source});editor.select({from:source.length,to:source.length});const inputs=[...document.querySelectorAll<HTMLInputElement>('.live-block input.task-list-item-checkbox')];assert.equal(inputs.length,2);inputs[0].click();assert.equal(editor.text(),source);inputs[1].click();assert.equal(editor.text(),source.replace('- [ ] later','- [x] later'));}finally{editor.destroy();}
  }
});
test('reserved command attributes in rendered document HTML do not trigger app saves',async()=>{
  const messages=hostFixture();const app=await mountApp(root());
  try{
    const source='<button data-action="save">Document button</button>\n\nend';app.editor.replace(source,{from:source.length,to:source.length});
    for(const mode of ['live','reading'] as const){
      app.setMode(mode);messages.length=0;const button=document.querySelector<HTMLButtonElement>(mode==='live'?'.live-block button[data-action="save"]':'.reading button[data-action="save"]')!;assert.ok(button);button.click();await new Promise(resolve=>setTimeout(resolve,0));
      assert.equal(messages.some(message=>message.method==='saveAs'||message.method==='saveDocument'),false);assert.equal(app.editor.text(),source);
    }
  }finally{app.destroy();}
});
test('live task clicks return focus to the editor so keyboard undo reaches the shared history',()=>{
  const editor=new DocumentEditor(root());
  try{
    editor.open({...snapshot,text:'- [ ] task\n\nend'});editor.select({from:16,to:16});
    const checkbox=document.querySelector<HTMLInputElement>('.live-block input[data-mori-task="true"]')!;
    checkbox.focus();assert.equal(editor.view.hasFocus,false);checkbox.click();
    assert.equal(editor.text(),'- [x] task\n\nend');assert.equal(editor.view.hasFocus,true);
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true,cancelable:true}));
    assert.equal(editor.text(),'- [ ] task\n\nend');
  }finally{editor.destroy();}
});
test('Space on a focused live task checkbox preserves its native toggle action',()=>{
  const editor=new DocumentEditor(root());
  try{
    editor.open({...snapshot,text:'- [ ] task\n\nend'});editor.select({from:16,to:16});
    const checkbox=document.querySelector<HTMLInputElement>('.live-block input[data-mori-task="true"]')!;checkbox.focus();
    const space=new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true});checkbox.dispatchEvent(space);
    assert.equal(space.defaultPrevented,false);assert.equal(document.activeElement,checkbox);
    checkbox.click();assert.equal(editor.text(),'- [x] task\n\nend');undo(editor.view);assert.equal(editor.text(),'- [ ] task\n\nend');
  }finally{editor.destroy();}
});
test('live images read exact native asset path from the document parent', async () => {
  hostFixture(); const app = await mountApp(root()); const messages: any[] = [];
  try { app.documents.get('a').path = '/folder/note.md'; transport(message => { messages.push(message); queueMicrotask(() => reply(message.id, { type: 'image/png', base64: 'AA==' })); }); app.editor.replace('![](assets/p.png)\n\nend', { from: 20, to: 20 }); app.editor.mode('source'); app.editor.mode('live'); await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(messages.find(message => message.method === 'readAsset').args, { path: '/folder/assets/p.png', root: '/folder' }); assert.equal(document.querySelector<HTMLImageElement>('.live-block img')!.getAttribute('src'), 'data:image/png;base64,AA=='); } finally { app.destroy(); }
});
test('live composition keeps existing widget DOM stable while source updates', () => {
  const editor = new DocumentEditor(root());
  try { editor.open({ ...snapshot, text: '- [ ] one\n\nend' }); editor.view.dispatch({ selection: { anchor: 12 } }); const widget = document.querySelector('.live-block'); assert.ok(widget); editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionstart', { bubbles: true })); editor.view.dispatch({ changes: { from: 12, insert: '한' } }); assert.equal(document.querySelector('.live-block'), widget); assert.equal(editor.text(), '- [ ] one\n\ne한nd'); editor.view.contentDOM.dispatchEvent(new win.CompositionEvent('compositionend', { bubbles: true })); } finally { editor.destroy(); }
});
test('client disposal rejects pending calls and handles late replies without touching DOM', async () => {
  const messages: any[] = []; transport(message => messages.push(message)); const client = new NativeClient(win as any); const pending = client.call('settings'); client.dispose(); await assert.rejects(pending, /Native client closed/); assert.doesNotThrow(() => reply(messages[0].id, {}));
});
test('footnote and reference link menu consumers change real source', async () => {
  hostFixture(); const app = await mountApp(root());
  try { assert.ok(document.querySelector('[data-command="footnote"]')); assert.ok(document.querySelector('[data-command="linkReference"]')); app.editor.view.dispatch({ selection: { anchor: 2, head: 7 } }); (win as any).__nativeCommand({ type: 'footnote' }); assert.equal(app.editor.text(), '# [^1]\n\n[^1]: Notes'); undo(app.editor.view); assert.equal(app.editor.text(), '# Notes'); } finally { app.destroy(); }
});
test('interactive file panel can outlast a tiny backend timeout and still adopt its reply', async context => {
  const originalTimer = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback: any, _delay: any, ...args: any[]) => originalTimer(callback, 5, ...args));
  const messages: any[] = []; transport(message => messages.push(message)); const client = new NativeClient(win as any); let settled = false;
  try {
    const result = client.call('chooseDocument').then(value => { settled = true; return value; }, error => { settled = true; return { error }; });
    await new Promise(resolve => originalTimer(resolve, 20)); assert.equal(settled, false, 'A visible file panel must not be rejected by the backend deadline');
    reply(messages[0].id, { ...snapshot, documentId: 'opened', path: '/fixture.md' });
    assert.deepEqual(await result, { ...snapshot, documentId: 'opened', path: '/fixture.md' });
  } finally { client.dispose(); }
});
test('noninteractive directory I/O retains its backend deadline', async context => {
  const originalTimer = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback: any, _delay: any, ...args: any[]) => originalTimer(callback, 5, ...args));
  transport(() => {}); const client = new NativeClient(win as any);
  try { await assert.rejects(client.call('listDirectory', { path: '/slow' }), /listDirectory did not respond/); } finally { client.dispose(); }
});
test('all native user-dialog methods have no client deadline', async context => {
  const originalTimer = globalThis.setTimeout; const scheduled: number[] = [];
  context.mock.method(globalThis, 'setTimeout', (callback: any, delay: any, ...args: any[]) => { scheduled.push(delay); return originalTimer(callback, 5, ...args); });
  const messages: any[] = []; transport(message => messages.push(message)); const client = new NativeClient(win as any);
  try { const pending = ['chooseDocument','chooseWorkspace','saveAs','saveDocument','export','import','importDocument','importImages','print'].map(method => client.call(method).catch(error => ({error}))); assert.deepEqual(scheduled, []); for (const message of messages) reply(message.id, null); assert.deepEqual(await Promise.all(pending), [null,null,null,null,null,null,null,null,null]); } finally { client.dispose(); }
});
test('runTool client budget includes requested native process timeout and delivery grace', async context => {
  const originalTimer = globalThis.setTimeout; const scheduled: number[] = [];
  context.mock.method(globalThis, 'setTimeout', (callback: any, delay: any, ...args: any[]) => { scheduled.push(delay); return originalTimer(callback, 5, ...args); });
  const messages: any[] = []; transport(message => messages.push(message)); const client = new NativeClient(win as any);
  try { const pending = client.call('runTool', { timeout: 120 }).catch(error => ({error})); assert.deepEqual(scheduled, [135000]); reply(messages[0].id, {exitCode:0,stdout:'done'}); assert.deepEqual(await pending, {exitCode:0,stdout:'done'}); } finally { client.dispose(); }
});
