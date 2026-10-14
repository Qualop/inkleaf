import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { proofreading, proofreadingState, setProofreadingResult, normalizeProofreadingResult, applyProofreadingSuggestion, showProofreadingSuggestions, refreshProofreading, annotatePreview } from '../client/proofreading.ts';

const issue = (from:number, to:number, kind:'spelling'|'grammar'='spelling', suggestions=['fixed']) => ({from,to,kind,message:'고칠 단어',suggestions});
const result = (issues:any[]) => ({issues,languages:['ko'],language:'ko'});
const tick = () => new Promise(resolve => setTimeout(resolve,15));

test('normalizer rejects invalid ranges, splits, code, malformed results and unbounded responses',()=>{
  const text='😀 typo\r\n`typo` [typo](typo)';
  const checked=normalizeProofreadingResult(text,result([issue(1,2),issue(3,7),issue(8,9),issue(10,14),issue(17,21),issue(23,27),issue(-1,4),issue(3,7)]));
  assert.deepEqual(checked.issues.map(i=>[i.from,i.to]),[[3,7],[17,21]]);
  assert.equal(normalizeProofreadingResult('typo '.repeat(400),result(Array.from({length:400},(_,i)=>issue(i*5,i*5+4)))).issues.length,200);
  assert.deepEqual(normalizeProofreadingResult(text,{issues:[null,{from:0,to:2,kind:'unknown'}]}).issues,[]);
});

function fixture(text:string,options:any={}) {
  const dom=new JSDOM('<div id="editor"></div>',{pretendToBeVisual:true}),win=dom.window;
  for(const name of ['window','document','Window','HTMLElement','Node','MutationObserver','DOMRect','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
    const value=(win as any)[name];Object.defineProperty(globalThis,name,{value:typeof value==='function'&&/Frame|Style/.test(name)?value.bind(win):value,configurable:true,writable:true});
  }
  win.Range.prototype.getClientRects=()=>[] as any;
  win.Range.prototype.getBoundingClientRect=()=>new win.DOMRect();
  const view=new EditorView({parent:win.document.getElementById('editor')!,state:EditorState.create({doc:text.replace(/\r\n/g,'\n'),extensions:[markdown(),history(),proofreading({check:async()=>result([]),debounceMs:0,...options})]})});
  return {view,win,dom,cleanup:()=>{view.destroy();dom.window.close();}};
}

test('suggestion is one undoable transaction and applies only against its original source',()=>{
  const f=fixture('😀 typo\r\nend',{getText:()=> '😀 typo\r\nend'});
  try {
    assert.equal(applyProofreadingSuggestion(f.view,issue(3,7),'fixed','😀 typo\r\nend'),true);
    assert.equal(f.view.state.doc.toString(),'😀 fixed\nend');assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'😀 typo\nend');
    f.view.dispatch({changes:{from:3,to:7,insert:'else'}});
    assert.equal(applyProofreadingSuggestion(f.view,issue(3,7),'fixed','😀 typo\r\nend'),false);
  } finally {f.cleanup();}
});

test('debounced checks discard stale documents and same-text older requests',async()=>{
  const pending:{text:string;done:(value:any)=>void}[]=[];
  const f=fixture('typo',{check:(text:string)=>new Promise(done=>pending.push({text,done}))});
  try {
    await tick();assert.equal(pending.length,1);
    f.view.dispatch({changes:{from:0,to:4,insert:'next'}});await tick();assert.equal(pending.length,2);
    pending[0].done(result([issue(0,4)]));await tick();assert.equal(f.view.state.field(proofreadingState).issues.length,0);
    refreshProofreading(f.view);await tick();assert.equal(pending.length,3);
    pending[1].done(result([issue(0,4)]));await tick();assert.equal(f.view.state.field(proofreadingState).issues.length,0);
    pending[2].done(result([issue(0,4)]));await tick();assert.equal(f.view.state.field(proofreadingState).issues.length,1);
  } finally {f.cleanup();}
});

test('disabling checks invalidates pending replies and clears marks immediately on refresh',async()=>{
  let enabled=true,finish!:(value:any)=>void,calls=0;
  const f=fixture('typo',{enabled:()=>enabled,check:()=>{calls++;return new Promise(done=>{finish=done;});}});
  try {
    await tick();assert.equal(calls,1);
    f.view.dispatch({effects:setProofreadingResult.of({text:'typo',result:result([issue(0,4)])})});
    assert.equal(f.view.state.field(proofreadingState).issues.length,1);
    enabled=false;refreshProofreading(f.view);assert.equal(f.view.state.field(proofreadingState).issues.length,0);
    finish(result([issue(0,4)]));await tick();assert.equal(calls,1);assert.equal(f.view.state.field(proofreadingState).issues.length,0);
  } finally {f.cleanup();}
});

test('replaced documents and destroyed views reject pending replies even with the same text',async()=>{
  const pending:((value:any)=>void)[]=[];
  const f=fixture('typo',{check:()=>new Promise(done=>pending.push(done))});
  await tick();assert.equal(pending.length,1);
  f.view.setState(EditorState.create({doc:'typo',extensions:[markdown(),proofreading({check:async()=>result([]),debounceMs:0})]}));
  pending[0](result([issue(0,4)]));await tick();assert.equal(f.view.state.field(proofreadingState).issues.length,0);
  f.cleanup();
});

test('CRLF result decorations map to normalized CodeMirror positions after earlier line endings',()=>{
  const source='first\r\n😀 typo\r\nlast',from=source.indexOf('typo'),f=fixture(source);
  try {
    f.view.dispatch({effects:setProofreadingResult.of({text:source,result:result([issue(from,from+4)])})});
    const ranges:any[]=[];f.view.state.field(proofreadingState).decorations.between(0,f.view.state.doc.length,(from,to)=>{ranges.push([from,to]);});
    assert.deepEqual(ranges,[[9,13]]);
    assert.equal(applyProofreadingSuggestion(f.view,issue(from,from+4),'fixed',source),true);
    assert.equal(f.view.state.doc.toString(),'first\n😀 fixed\nlast');assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'first\n😀 typo\nlast');
  } finally {f.cleanup();}
});

test('personal dictionary suggestion action calls only the supplied callback',async()=>{
  const learned:string[]=[],f=fixture('typo',{onLearn:(word:string)=>{learned.push(word);}});
  try {
    f.view.dispatch({effects:setProofreadingResult.of({text:'typo',result:result([issue(0,4)])})});
    assert.equal(showProofreadingSuggestions(f.view),true);
    const button=[...f.view.dom.querySelectorAll('button')].find(button=>button.textContent==='개인 사전에 추가')!;button.click();await tick();
    assert.deepEqual(learned,['typo']);assert.equal(f.view.state.doc.toString(),'typo');
  } finally {f.cleanup();}
});

test('suggestion controls and common messages use the supplied UI language',()=>{
  const f=fixture('typo',{uiLanguage:()=> 'en'});try {
    const item={...issue(0,4),message:'철자를 확인하세요.',suggestions:[]};
    f.view.dispatch({effects:setProofreadingResult.of({text:'typo',result:result([item])})});
    assert.equal(showProofreadingSuggestions(f.view),true);
    const popup=f.view.dom.querySelector('[role="dialog"]')!;assert.equal(popup.getAttribute('aria-label'),'Spelling suggestions');
    assert.match(popup.textContent!,/Check spelling/);assert.match(popup.textContent!,/No suggestions/);assert.match(popup.textContent!,/Close/);assert.doesNotMatch(popup.textContent!,/추천|닫기|철자/);
  } finally {f.cleanup();}
});

test('spelling/grammar marks and keyboard suggestions offer an explicit apply action',()=>{
  const f=fixture('typo gap');try {
    f.view.dispatch({effects:setProofreadingResult.of({text:'typo gap',result:result([issue(0,4),issue(5,8,'grammar',['space'])])})});
    assert.ok(f.view.dom.querySelector('.mori-spelling'));assert.ok(f.view.dom.querySelector('.mori-grammar'));
    f.view.dispatch({selection:{anchor:6}});assert.equal(showProofreadingSuggestions(f.view),true);
    const dialog=f.view.dom.querySelector('[role="dialog"]')!;assert.match(dialog.textContent!,/space/);
    (dialog.querySelector('[data-proofreading-suggestion]') as HTMLButtonElement).click();assert.equal(f.view.state.doc.toString(),'typo space');
    assert.equal(undo(f.view),true);assert.equal(f.view.state.doc.toString(),'typo gap');
  } finally {f.cleanup();}
});

test('click, context menu and Alt-Enter open the same guarded suggestion actions',()=>{
  const f=fixture('typo');try {
    f.view.dispatch({effects:setProofreadingResult.of({text:'typo',result:result([issue(0,4)])})});
    const mark=f.view.dom.querySelector('.mori-spelling')!;
    mark.dispatchEvent(new f.win.MouseEvent('click',{bubbles:true}));assert.ok(f.view.dom.querySelector('[role="dialog"]'));
    (f.view.dom.querySelector('[role="dialog"] button:last-child') as HTMLButtonElement).click();
    const context=new f.win.MouseEvent('contextmenu',{bubbles:true,cancelable:true});mark.dispatchEvent(context);assert.equal(context.defaultPrevented,true);assert.ok(f.view.dom.querySelector('[role="dialog"]'));
    (f.view.dom.querySelector('[role="dialog"] button:last-child') as HTMLButtonElement).click();
    f.view.contentDOM.dispatchEvent(new f.win.KeyboardEvent('keydown',{key:'Enter',code:'Enter',altKey:true,bubbles:true,cancelable:true}));
    assert.ok(f.view.dom.querySelector('[role="dialog"]'));assert.equal(f.view.state.doc.toString(),'typo');
  } finally {f.cleanup();}
});

test('preview annotation marks matching prose without touching code or duplicate unrelated words',()=>{
  const dom=new JSDOM('<div contenteditable="false"><div id="root"><p>typo <strong>typo</strong></p><code>typo</code><pre>typo</pre></div></div>');
  const root=dom.window.document.getElementById('root')!;
  annotatePreview(root,'typo **typo**',result([issue(0,4)]));
  assert.equal(root.querySelectorAll('.mori-spelling').length,1);assert.equal(root.querySelector('strong')!.textContent,'typo');assert.equal(root.querySelector('code')!.innerHTML,'typo');
  dom.window.close();
});

test('preview annotation uses the supplied source block range and skips transformed/overlapping code',()=>{
  const dom=new JSDOM('<div id="root"><p>typo</p><code>typo</code><p>A &amp; B</p></div>'),root=dom.window.document.getElementById('root')!;
  const source='typo\n\n`typo`\n\ntypo\n\nA &amp; B',from=source.lastIndexOf('typo');
  annotatePreview(root,source,result([issue(0,4),issue(from,from+4)]),{from,to:source.length});
  const marks=root.querySelectorAll('.mori-spelling');assert.equal(marks.length,1);assert.equal((marks[0] as HTMLElement).dataset.proofreadingFrom,String(from));assert.equal(root.querySelector('code')!.innerHTML,'typo');
  annotatePreview(root,source,result([]),{from,to:source.length});assert.equal(root.querySelectorAll('.mori-spelling').length,0);assert.equal(root.querySelector('p')!.textContent,'typo');
  dom.window.close();
});

test('preview issue clicks and keyboard actions do not reach a live widget parent handler',()=>{
  const dom=new JSDOM('<div id="root"><p>typo</p></div>'),root=dom.window.document.getElementById('root')!;
  const called:any[]=[];let reset=0;root.addEventListener('click',()=>reset++);root.addEventListener('keydown',()=>reset++);
  annotatePreview(root,'typo',result([issue(0,4)]),{onIssue:item=>called.push(item)});
  const mark=root.querySelector('.mori-spelling')!;
  const click=new dom.window.MouseEvent('click',{bubbles:true,cancelable:true});mark.dispatchEvent(click);
  const key=new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});mark.dispatchEvent(key);
  assert.equal(reset,0);assert.equal(called.length,2);assert.equal(click.defaultPrevented,true);assert.equal(key.defaultPrevented,true);dom.window.close();
});
