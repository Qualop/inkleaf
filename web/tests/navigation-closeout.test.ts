import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,q,find,snap,until,tick} from './navigation-harness.ts';

test('quit approval rejects a pending encoding transaction before its acknowledgement',async t=>{
  let release:(value:any)=>void=()=>{},request:any;
  const {app,messages}=await fixture(t,{source:'disk',settings:{restoreUnsaved:true},handle:m=>m.method==='setDocumentFormat'?(request=m.args,new Promise(resolve=>{release=resolve;})):undefined});
  const format=app.setEncoding('utf16le');await until(()=>!!request);
  const accepted=await app.prepareForClose('quit');
  release({...snap('a',request.text),revision:request.revision,encoding:request.encoding});await format;
  assert.equal(accepted,false,'a pending native format operation cannot be approved for quit');
  assert.equal(messages.filter(m=>m.method==='keepRecovery').length,0);
  assert.equal(await app.prepareForClose('quit'),true,'completed format change can checkpoint and close');
  assert.ok(messages.some(m=>m.method==='checkpoint'&&m.args.revision===app.documents.get('a')!.revision));
});

for(const changed of [true,false])test(`folder result completion ${changed?'ignores a superseded click':'selects a current matching line'}`,async t=>{
  let release:(value:any)=>void=()=>{},opening=false;
  const {app}=await fixture(t,{source:'original',handle:m=>m.method==='chooseWorkspace'?'/work':m.method==='listDirectory'?[]:m.method==='searchWorkspace'?[{path:'/work/target.md',line:1,from:2,to:5,text:'x old'}]:m.method==='openDocument'?(opening=true,new Promise(resolve=>{release=resolve;})):undefined});
  await app.action('folder');find('old');await app.action('workspace-search');
  q<HTMLButtonElement>('[data-search-results] button').click();await until(()=>opening);
  if(changed)find('new');
  release(snap('target',changed?'changed file content':'x old','/work/target.md'));await tick();await tick();
  if(changed){assert.equal(app.editor.text(),'original');assert.equal(app.activeId,'a');}
  else {assert.equal(app.editor.text(),'x old');assert.deepEqual(app.editor.selection(),{from:2,to:5});}
});

test('folder result refuses stale offsets when the returned file line changed on disk',async t=>{
  const {app}=await fixture(t,{source:'original',handle:m=>m.method==='chooseWorkspace'?'/work':m.method==='listDirectory'?[]:m.method==='searchWorkspace'?[{path:'/work/target.md',line:1,from:2,to:5,text:'x old'}]:m.method==='openDocument'?snap('target','changed file content','/work/target.md'):undefined});
  await app.action('folder');find('old');await app.action('workspace-search');q<HTMLButtonElement>('[data-search-results] button').click();await tick();await tick();
  assert.equal(app.editor.text(),'changed file content');assert.deepEqual(app.editor.selection(),{from:0,to:0});
});
