import test from 'node:test';
import assert from 'node:assert/strict';
import { undo,redo } from '@codemirror/commands';
import { fixture,q,find,change,snap,until,tick,button } from './navigation-harness.ts';

const dirty=()=>q('[data-document="a"]').dataset.dirty;
const clean=()=>assert.match(q('[data-save-state]').textContent!,/Saved to file/);
const bootstrap=(extra:any={})=>({settings:{language:'en',watchFiles:false,spellcheck:false,grammarCheck:false},recoveries:[],unsavedAssetRoot:'/scratch/unsaved',...extra});

test('untitled converted import previews extracted images and includes their shared root in first Save As',async t=>{
  const imported=snap('imported','![image](import-case/media/image.png)',null);
  const {app,messages}=await fixture(t,{handle:m=>m.method==='bootstrap'?bootstrap():m.method==='importDocument'?imported:m.method==='readAsset'?{type:'image/png',base64:'AA=='}:m.method==='saveAs'?{...imported,text:'![image](assets/image.png)',path:'/saved/import.md',revision:m.args.revision,savedDigest:'published'}:undefined});
  await app.action('import');app.setMode('reading');await until(()=>messages.some(m=>m.method==='readAsset'));
  const read=messages.find(m=>m.method==='readAsset');assert.equal(read.args.root,'/scratch/unsaved');assert.equal(read.args.path,'/scratch/unsaved/import-case/media/image.png');
  await app.save();const save=messages.find(m=>m.method==='saveAs');assert.equal(save.args.assetRoot,'/scratch/unsaved');assert.equal(save.args.imageReferences[0].path,'/scratch/unsaved/import-case/media/image.png');
  assert.equal(app.editor.text(),'![image](assets/image.png)');assert.match(q('[data-save-state]').textContent!,/Saved to file/);
});

test('bound plain imports keep their own parent as image root',async t=>{
  const {app,messages}=await fixture(t,{handle:m=>m.method==='bootstrap'?bootstrap():m.method==='importDocument'?snap('plain','![image](assets/image.png)','/files/plain.md'):m.method==='readAsset'?{type:'image/png',base64:'AA=='}:undefined});
  await app.action('import');app.setMode('reading');await until(()=>messages.some(m=>m.method==='readAsset'));
  const read=messages.find(m=>m.method==='readAsset');assert.equal(read.args.root,'/files');assert.equal(read.args.path,'/files/assets/image.png');
});

test('a restored imported draft resolves extracted media from the bootstrap root before saving',async t=>{
  const imported={...snap('imported','![image](import-case/media/image.png)',null),revision:3};
  const {app,messages}=await fixture(t,{handle:m=>m.method==='bootstrap'?bootstrap({settings:{language:'en',mode:'reading',watchFiles:false,spellcheck:false,grammarCheck:false,session:{documents:[{documentId:'imported',path:null}],activeDocumentId:'imported'}},recoveries:[imported]}):m.method==='restoreDocument'?imported:m.method==='readAsset'?{type:'image/png',base64:'AA=='}:undefined});
  await until(()=>messages.some(m=>m.method==='readAsset'));assert.equal(messages.find(m=>m.method==='readAsset').args.root,'/scratch/unsaved');assert.equal(app.editor.text(),imported.text);
});

test('Save then Replace All then Undo recognizes saved source without rewinding revisions',async t=>{
  const source='한국 cat\r\ncat 😀';
  const {app,messages}=await fixture(t,{source,handle:m=>m.method==='saveDocument'?{revision:m.args.revision,savedDigest:'saved-now'}:undefined});
  await app.save();const acknowledged=app.documents.get('a')!.savedRevision;
  await app.action('find');find('cat');change('[data-control="replacement"]','dog');await app.action('replace-all');assert.equal(dirty(),'true');
  const edited=app.documents.get('a')!.revision;undo(app.editor.view);assert.equal(app.editor.text(),source);assert.ok(app.documents.get('a')!.revision>edited);assert.equal(app.documents.get('a')!.savedRevision,acknowledged);
  clean();assert.equal(dirty(),'false');await tick();assert.equal(messages.filter(m=>m.method==='setWindowTitle').at(-1).args.edited,false);
  redo(app.editor.view);assert.equal(dirty(),'true');undo(app.editor.view);clean();
});

test('a pending save does not mark newer content clean until its matching acknowledgement',async t=>{
  const pending:{request:any;resolve:(value:any)=>void}[]=[];
  const {app}=await fixture(t,{source:'disk',handle:m=>m.method==='saveDocument'?new Promise(resolve=>pending.push({request:m.args,resolve})):undefined});
  app.editor.replace('first');const first=app.save();await until(()=>pending.length===1);app.editor.replace('second');
  pending[0].resolve({revision:pending[0].request.revision,savedDigest:'first-on-disk'});await first;assert.equal(dirty(),'true');assert.equal(app.editor.text(),'second');
  const second=app.save();await until(()=>pending.length===2);assert.equal(dirty(),'true');pending[1].resolve({revision:pending[1].request.revision,savedDigest:'second-on-disk'});await second;clean();
  undo(app.editor.view);assert.equal(dirty(),'true');redo(app.editor.view);clean();
});

test('undo to the saved pending request becomes clean only when that request is acknowledged',async t=>{
  let release:(value:any)=>void=()=>{},request:any;
  const {app}=await fixture(t,{source:'disk',handle:m=>m.method==='saveDocument'?(request=m.args,new Promise(resolve=>{release=resolve;})):undefined});
  app.editor.replace('first');const saved=app.save();app.editor.replace('second');undo(app.editor.view);assert.equal(app.editor.text(),'first');assert.equal(dirty(),'true');
  release({revision:request.revision,savedDigest:'first-on-disk'});await saved;clean();assert.ok(app.documents.get('a')!.revision>app.documents.get('a')!.savedRevision);
});

test('encoding changes remain dirty even after undo restores saved text; format acknowledgement cannot erase this',async t=>{
  const {app}=await fixture(t,{source:'disk',handle:m=>m.method==='setDocumentFormat'?{...snap('a',m.args.text),revision:m.args.revision,encoding:m.args.encoding}:m.method==='saveDocument'?{revision:m.args.revision,savedDigest:'utf16-saved'}:undefined});
  await app.setEncoding('utf16le');app.editor.replace('edit');undo(app.editor.view);assert.equal(app.editor.text(),'disk');assert.equal(dirty(),'true');
  await app.save();clean();app.editor.replace('again');undo(app.editor.view);clean();assert.equal(app.documents.get('a')!.encoding,'utf16le');
});

test('encoding changed while a save is pending is not mistaken for the encoding of that saved request',async t=>{
  let release:(value:any)=>void=()=>{},request:any;
  const {app}=await fixture(t,{source:'disk',handle:m=>m.method==='saveDocument'?(request=m.args,new Promise(resolve=>{release=resolve;})):m.method==='setDocumentFormat'?{...snap('a',m.args.text),revision:m.args.revision,encoding:m.args.encoding}:undefined});
  const saving=app.save();await app.setEncoding('utf16be');release({revision:request.revision,savedDigest:'utf8-on-disk'});await saving;assert.equal(dirty(),'true');
  await app.setEncoding('utf8');clean();
});

test('restored draft with unknown saved source stays dirty after undo returns to its restored text',async t=>{
  const draft={...snap('a','restored edits'),revision:9,savedDigest:'digest-is-not-source'};
  const {app}=await fixture(t,{handle:m=>m.method==='bootstrap'?bootstrap({settings:{language:'en',watchFiles:false,spellcheck:false,grammarCheck:false,session:{documents:[{documentId:'a',path:'/a.md'}],activeDocumentId:'a'}},recoveries:[draft]}):m.method==='restoreDocument'?draft:undefined});
  app.editor.replace('other');undo(app.editor.view);assert.equal(app.editor.text(),'restored edits');assert.equal(dirty(),'true');assert.match(q('[data-save-state]').textContent!,/Unsaved file changes/);
});

test('reload replaces the clean content baseline and undoing back to it is clean',async t=>{
  let external=true;
  const {app}=await fixture(t,{source:'original',settings:{watchFiles:true},handle:m=>m.method==='observeDocument'?{status:external?'modified':'unchanged',diskDigest:'new-digest'}:m.method==='reloadDocument'?(external=false,{...snap('a','disk update'),revision:m.args.revision,savedDigest:'new-digest'}):undefined});
  await app.action('check-files');assert.equal(app.editor.text(),'disk update');app.editor.replace('new edit');undo(app.editor.view);clean();
});

test('undo-clean state survives tab switching and close clears the old recovery before releasing the document',async t=>{
  const {app,messages}=await fixture(t,{source:'disk'});app.editor.replace('edit');undo(app.editor.view);clean();
  await app.action('open');q<HTMLButtonElement>('[data-document="a"] [role="tab"]').click();clean();
  await app.action('close-document');assert.equal(app.documents.has('a'),false);assert.equal(document.querySelector('dialog'),null);
  const close=messages.findIndex(m=>m.method==='closeDocument'&&m.args.documentId==='a'),checkpoint=messages.findIndex(m=>m.method==='checkpoint'&&m.args.documentId==='a');
  assert.ok(checkpoint>=0&&checkpoint<close);assert.equal(messages[checkpoint].args.text,'disk');
  assert.equal(messages.filter(m=>m.method==='saveDocument').length,0);
});

test('closing during an in-flight save waits for its acknowledged baseline before deciding whether edits can close',async t=>{
  let release:(value:any)=>void=()=>{},request:any;
  const {app,messages}=await fixture(t,{source:'disk',handle:m=>m.method==='saveDocument'?(request=m.args,new Promise(resolve=>{release=resolve;})):undefined});
  app.editor.replace('first');const saving=app.save();undo(app.editor.view);assert.equal(app.editor.text(),'disk');
  const closing=app.action('close-document');await tick();assert.equal(messages.some(m=>m.method==='closeDocument'),false);
  release({revision:request.revision,savedDigest:'first-on-disk'});await saving;await until(()=>!!document.querySelector('dialog'));
  assert.equal(dirty(),'true');button('Cancel',q('dialog')).click();await closing;assert.equal(app.documents.has('a'),true);assert.equal(app.editor.text(),'disk');
});

test('quitting an undo-clean document flushes its latest source but does not retain a stale draft',async t=>{
  const {app,messages}=await fixture(t,{source:'disk'});app.editor.replace('edit');undo(app.editor.view);
  assert.equal(await app.prepareForClose('quit'),true);assert.equal(document.querySelector('dialog'),null);
  assert.ok(messages.some(m=>m.method==='checkpoint'&&m.args.text==='disk'));
  assert.equal(messages.some(m=>m.method==='keepRecovery'),false);
});

test('quit waits for a pending save before deciding whether undo content needs recovery',async t=>{
  let release:(value:any)=>void=()=>{},request:any,settled=false;
  const {app,messages}=await fixture(t,{source:'disk',handle:m=>m.method==='saveDocument'?(request=m.args,new Promise(resolve=>{release=resolve;})):undefined});
  app.editor.replace('first');const saving=app.save();undo(app.editor.view);
  const closing=app.prepareForClose('quit').then(result=>{settled=true;return result;});
  try{await tick();await tick();assert.equal(settled,false,'cannot approve quit using a baseline that an in-flight save will replace');}
  finally{release({revision:request.revision,savedDigest:'first-on-disk'});await saving;await closing;}
  assert.ok(messages.some(m=>m.method==='checkpoint'&&m.args.text==='disk'));
  assert.ok(messages.some(m=>m.method==='keepRecovery'&&m.args.documentId==='a'));
});
