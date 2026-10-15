// Mounted regressions for the navigation audit, including delayed native replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,q,find,change,setting,option,button,until,tick } from './navigation-harness.ts';
import { EditorView } from '@codemirror/view';

test('previous match from a new search selects the last occurrence',async t=>{
  const {app}=await fixture(t,{source:'cat one cat two cat'});await app.action('find');find('cat');await app.action('previous-match');
  assert.deepEqual(app.editor.selection(),{from:16,to:19});
});

test('replace-one invalidates cached offsets immediately after a source edit',async t=>{
  const {app}=await fixture(t,{source:'xx cat'});await app.action('find');find('cat');change('[data-control="replacement"]','X');
  app.editor.replace('safe');await app.action('replace-one');assert.equal(app.editor.text(),'safe');
});

test('personal dictionary renders one word per line and survives an unrelated change',async t=>{
  const {app,settings}=await fixture(t,{settings:{personalDictionary:['Inkleaf','한글']}});await app.action('settings');
  const control=q<HTMLTextAreaElement>('[data-setting="personalDictionary"]');assert.equal(control.value,'Inkleaf\n한글');
  control.dispatchEvent(new Event('change',{bubbles:true}));await tick();assert.deepEqual(settings().personalDictionary,['Inkleaf','한글']);
  change('[data-document-preference-scope]',true);change('[data-document-preference-scope]',false);
  const leaf=q<HTMLInputElement>('[data-setting="appIcon"][value="leaf"]');leaf.checked=true;leaf.dispatchEvent(new Event('change',{bubbles:true}));
  assert.equal(control.value,'Inkleaf\n한글');assert.deepEqual(app.preferences.personalDictionary,['Inkleaf','한글']);
});

test('quick-open matches canonically equivalent Unicode filenames',async t=>{
  const {app}=await fixture(t,{settings:{recentFiles:['/work/Cafe\u0301.md']}});await app.action('quick-open');change('dialog input','Café','input');
  assert.equal(q('.quick-results button')?.title,'/work/Cafe\u0301.md');
});

test('an old folder search response cannot replace a newer document search',async t=>{
  let release:(value:any)=>void=()=>{};
  const {app}=await fixture(t,{source:'new',handle:m=>m.method==='chooseWorkspace'?'/work':m.method==='listDirectory'?[]:m.method==='searchWorkspace'?new Promise(resolve=>{release=resolve;}):undefined});
  await app.action('folder');await app.action('find');find('old');const pending=app.action('workspace-search');
  await until(()=>q('[data-search-status]').textContent==='Searching folder…');await app.action('find');find('new');
  release([{path:'/work/old.md',line:1,from:0,to:3,text:'old'}]);await pending;
  assert.match(q('[data-search-status]').textContent!,/^1 match in this document/);assert.equal(q('[data-search-results]').children.length,0);
});

test('theme refresh shows edit/delete controls for a theme added by another window',async t=>{
  let available=false;
  const {app}=await fixture(t,{handle:m=>m.method==='themeFiles'?{themes:available?[{id:'other',name:'Other window',css:'p{color:red}'}]:[]}:undefined});
  await app.action('themes');available=true;
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Refresh Themes')!.click();
  await until(()=>!!document.querySelector('[data-theme-option="user:other"]'));
  assert.ok([...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Edit CSS'));
  assert.ok([...document.querySelectorAll('dialog button')].find(button=>button.textContent==='Delete Theme'));
  available=false;button('Refresh Themes').click();await until(()=>!document.querySelector('[data-theme-option="user:other"]'));
  assert.equal(document.querySelector('.theme-file-tools'),null,'refresh removes controls for deleted themes');
});

for(const variant of ['query','options','source','document','mode','workspace'])test(`folder search invalidates ${variant} changes even when restored before the reply`,async t=>{
  let release:(value:any)=>void=()=>{},folder='/work';
  const {app,messages}=await fixture(t,{source:'old',handle:m=>m.method==='chooseWorkspace'?folder:m.method==='listDirectory'?[]:m.method==='searchWorkspace'?new Promise(resolve=>{release=resolve;}):undefined});
  await app.action('open');q<HTMLButtonElement>('[data-document="a"] [role="tab"]').click();
  await app.action('folder');await app.action('find');find('old');const pending=app.action('workspace-search');
  await until(()=>q('[data-search-status]').textContent==='Searching folder…');
  if(variant==='query'){find('new');find('old');}
  if(variant==='options'){option('wholeWord',true);option('wholeWord',false);}
  if(variant==='source'){app.editor.replace('new');app.editor.replace('old');}
  if(variant==='document'){q<HTMLButtonElement>('[data-document="b"] [role="tab"]').click();q<HTMLButtonElement>('[data-document="a"] [role="tab"]').click();}
  if(variant==='mode'){app.setMode('source');app.setMode('live');}
  if(variant==='workspace'){folder='/other';await app.action('folder');folder='/work';await app.action('folder');}
  release([{path:'/work/old.md',line:1,from:0,to:3,text:'old'}]);await pending;
  assert.equal(q('[data-search-results]').children.length,0);
  assert.doesNotMatch(q('[data-search-status]').textContent!,/folder matches/);
  assert.ok(messages.some(m=>m.method==='cancelSearch'),'superseded native work is cancelled');
});

test('same-millisecond folder searches use distinct identities and stale rejection cannot replace new results',async t=>{
  const pendingRequests:{message:any;resolve:(value:any)=>void;reject:(error:Error)=>void}[]=[];
  const {app}=await fixture(t,{handle:m=>m.method==='chooseWorkspace'?'/work':m.method==='listDirectory'?[]:m.method==='searchWorkspace'?new Promise((resolve,reject)=>pendingRequests.push({message:m,resolve,reject})):undefined});
  await app.action('folder');find('old');const now=Date.now;Date.now=()=>1;t.after(()=>{Date.now=now;});
  const old=app.action('workspace-search');await until(()=>pendingRequests.length===1);
  const fresh=app.action('workspace-search');await until(()=>pendingRequests.length===2);
  assert.notEqual(pendingRequests[0].message.args.jobId,pendingRequests[1].message.args.jobId);
  pendingRequests[1].resolve([{path:'/work/new.md',line:1,from:0,to:3,text:'old'}]);await fresh;
  pendingRequests[0].reject(new Error('old search cancelled'));await old;
  assert.equal(q('[data-search-results] button').title,'/work/new.md');assert.equal(q('[data-action="cancel-job"]').hidden,true);
});

function frames(t:any){
  const scheduled:FrameRequestCallback[]=[],raf=globalThis.requestAnimationFrame,cancel=globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame=callback=>{scheduled.push(callback);return scheduled.length;};globalThis.cancelAnimationFrame=()=>{};
  const scroll=EditorView.scrollIntoView,centered:number[]=[];
  EditorView.scrollIntoView=(position,options)=>{if(options?.y==='center')centered.push(typeof position==='number'?position:position.head);return scroll(position,options);};
  t.after(()=>{globalThis.requestAnimationFrame=raf;globalThis.cancelAnimationFrame=cancel;EditorView.scrollIntoView=scroll;});
  const flush=()=>{for(const callback of scheduled.splice(0))callback(0);};return {scheduled,centered,flush};
}

for(const variant of ['disabled','document','mode','selection','destroy'])test(`typewriter rejects a queued frame after ${variant} changes`,async t=>{
  const {app}=await fixture(t,{settings:{typewriter:true},source:'one\n\ntwo'}),queue=frames(t);
  app.editor.select({from:1,to:1});assert.ok(queue.scheduled.length);
  const stale=queue.scheduled.splice(0);
  if(variant==='disabled')await app.action('typewriter');
  if(variant==='document')await app.action('open');
  if(variant==='mode')app.setMode('reading');
  if(variant==='selection')app.editor.select({from:6,to:6});
  if(variant==='destroy')app.destroy();
  for(const callback of stale)callback(0);
  assert.deepEqual(queue.centered,[]);
  if(variant==='selection'){queue.flush();assert.deepEqual(queue.centered,[6]);}
});

test('background refreshes do not recenter typewriter; a real edit recenters once',async t=>{
  const {app}=await fixture(t,{settings:{typewriter:true},source:'one\n\ntwo'}),queue=frames(t);
  await app.action('outline');queue.flush();assert.deepEqual(queue.centered,[],'outline/statistics refresh is not an editing event');
  app.editor.select({from:1,to:1});queue.flush();assert.deepEqual(queue.centered,[1]);queue.centered.length=0;
  app.editor.view.dispatch({changes:{from:1,insert:'!'},selection:{anchor:2}});queue.flush();assert.deepEqual(queue.centered,[2]);
  await new Promise(resolve=>setTimeout(resolve,140));queue.flush();assert.deepEqual(queue.centered,[2],'delayed refresh must not schedule a second center');
});
