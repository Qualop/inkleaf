import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,q,win,tick } from './navigation-harness.ts';

function nativeHistory(t:any){
  const previous=Object.getOwnPropertyDescriptor(document,'execCommand'),calls:{command:string;active:Element|null}[]=[];
  Object.defineProperty(document,'execCommand',{configurable:true,value:(command:string)=>{calls.push({command,active:document.activeElement});return false;}});
  t.after(()=>{if(previous)Object.defineProperty(document,'execCommand',previous);else delete (document as any).execCommand;});
  return calls;
}
async function menu(command:'undo'|'redo'){(win as any).__nativeCommand({type:command});await tick();}

for(const kind of ['Find','Replace','Settings','Table','Contenteditable'])test(`native Undo/Redo belongs to the focused ${kind} form and never changes document history`,async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');
  if(kind==='Find'||kind==='Replace')await app.action('find');
  if(kind==='Settings'){await app.action('settings');await tick();q<HTMLButtonElement>('button[data-settings-category="appearance"]').click();}
  if(kind==='Table'){app.editor.select({from:0,to:0});await app.action('table');}
  let control:HTMLElement;
  if(kind==='Contenteditable'){control=document.createElement('div');control.setAttribute('contenteditable','true');control.tabIndex=0;control.textContent='form edit';app.root.append(control);}
  else {control=q(kind==='Find'?'[data-control="find"]':kind==='Replace'?'[data-control="replacement"]':kind==='Settings'?'[data-setting="customCSS"]':'.table-dialog textarea');(control as HTMLInputElement).value='form edit';}
  await tick();control.focus();assert.equal(document.activeElement,control);
  const source=app.editor.text(),revision=app.documents.get('a')!.revision,selection=app.editor.selection();
  for(const command of ['undo','redo'] as const){
    await menu(command);
    assert.equal(app.editor.text(),source,`${command} must not mutate the editor behind ${kind}`);
    assert.equal(app.documents.get('a')!.revision,revision);assert.deepEqual(app.editor.selection(),selection);assert.equal(document.activeElement,control);
  }
  assert.deepEqual(calls.map(call=>call.command),['undo','redo']);assert.ok(calls.every(call=>call.active===control));
  // execCommand deliberately returns false: unavailable native history must never fall back to CodeMirror.
});

test('native Undo/Redo uses editor history from nonediting app chrome',async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');
  q<HTMLButtonElement>('[data-action="save"]').focus();
  await menu('undo');assert.equal(app.editor.text(),'base');await menu('redo');assert.equal(app.editor.text(),'changed');assert.deepEqual(calls,[]);
});

test('native Undo/Redo still uses CodeMirror history when editor content owns focus',async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');app.editor.view.focus();
  assert.equal(document.activeElement,app.editor.view.contentDOM);
  await menu('undo');assert.equal(app.editor.text(),'base');await menu('redo');assert.equal(app.editor.text(),'changed');assert.deepEqual(calls,[]);
});

test('HTML Edit menu Undo/Redo buttons preserve document history after clicks move focus to chrome',async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');
  const edit=q<HTMLDetailsElement>('[data-menu="edit"]');
  for(const [action,expected] of [['undo','base'],['redo','changed']]){
    edit.open=true;
    const control=q<HTMLButtonElement>(`[data-menu="edit"] [data-action="${action}"]`);control.focus();assert.equal(document.activeElement,control);control.click();await tick();
    assert.equal(app.editor.text(),expected,action);assert.equal(edit.open,false,'actual delegated menu handler ran');
  }
  assert.deepEqual(calls,[]);
});

for(const kind of ['Settings','Table'])test(`native Undo/Redo cannot mutate editor when a nonediting ${kind} modal button owns focus`,async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');
  if(kind==='Settings')await app.action('settings');else {app.editor.select({from:0,to:0});await app.action('table');}
  await tick();q<HTMLButtonElement>('dialog header button').focus();const revision=app.documents.get('a')!.revision;
  await menu('undo');await menu('redo');assert.equal(app.editor.text(),'changed');assert.equal(app.documents.get('a')!.revision,revision);assert.deepEqual(calls,[]);
});

test('direct action Undo/Redo preserves editor history when nonediting app root owns focus',async t=>{
  const {app}=await fixture(t,{source:'base'}),calls=nativeHistory(t);app.editor.replace('changed');app.root.tabIndex=0;app.root.focus();
  await app.action('undo');assert.equal(app.editor.text(),'base');await app.action('redo');assert.equal(app.editor.text(),'changed');assert.deepEqual(calls,[]);
});
