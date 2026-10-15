import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { DocumentEditor } from '../client/editor.ts';
import { mountApp } from '../client/app.ts';
import { proofreadingState } from '../client/proofreading.ts';

const dom=new JSDOM('<div id="spelling-root"></div>',{url:'https://mori.local/',pretendToBeVisual:true}),win=dom.window;
for(const key of ['window','Window','Document','document','HTMLElement','Element','Node','Text','MutationObserver','DOMRect','Range','Event','KeyboardEvent','MouseEvent','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','AbortController','AbortSignal','DOMParser'])Object.defineProperty(globalThis,key,{value:key==='window'?win:(win as any)[key],configurable:true,writable:true});
Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});
Object.defineProperty(globalThis,'getComputedStyle',{value:win.getComputedStyle.bind(win),configurable:true});
Object.defineProperty(globalThis,'requestAnimationFrame',{value:win.requestAnimationFrame.bind(win),configurable:true});
Object.defineProperty(globalThis,'cancelAnimationFrame',{value:win.cancelAnimationFrame.bind(win),configurable:true});
const rect=()=>({x:0,y:0,top:0,left:0,right:800,bottom:600,width:800,height:600,toJSON(){return{};}});
(win.Range.prototype as any).getBoundingClientRect=rect;(win.Range.prototype as any).getClientRects=()=>[];
win.HTMLElement.prototype.getBoundingClientRect=rect;win.HTMLElement.prototype.scrollIntoView=function(){};
(win as any).matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
const empty=(language='ko')=>({issues:[],languages:['ko','en'],language});
function root(){const element=document.getElementById('spelling-root')!;element.replaceChildren();return element;}
async function until(ready:()=>boolean){for(let i=0;i<200;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for proofreading');}
function host(source:string,check:(language:string)=>any,settings:Record<string,unknown>={}){
  const messages:any[]=[];
  (win as any).webkit={messageHandlers:{native:{postMessage(message:any){messages.push(message);queueMicrotask(()=>{
    const result=message.method==='bootstrap'?{settings:{language:'en',watchFiles:false,...settings},recoveries:[]}:message.method==='createDocument'?{documentId:'spelling',path:null,text:source,revision:0,savedDigest:null,encoding:'utf8',lineEnding:'LF'}:message.method==='proofread'?check(message.args.language):{};
    (win as any).__nativeReply({id:message.id,ok:true,result});
  });}}}};return messages;
}
function change(key:string,value:boolean){const control=document.querySelector<HTMLInputElement>(`[data-setting="${key}"]`)!;assert.ok(control);control.checked=value;control.dispatchEvent(new Event('change',{bubbles:true}));}

test('custom proofreading owns underlines while standalone editors honor the native spellcheck option',()=>{
  const editor=new DocumentEditor(root(),{proofreading:{check:async()=>empty()}});try{
    for(const spellcheck of [true,false,true]){
      editor.configure({spellcheck});editor.open({documentId:String(spellcheck),path:null,text:'한글 hello',revision:0,savedDigest:null,encoding:'utf8',lineEnding:'LF'});
      assert.equal(editor.view.contentDOM.getAttribute('spellcheck'),'false','WebKit must not add a second checker');
      assert.equal(editor.view.contentDOM.getAttribute('autocorrect'),'off');
      assert.equal(editor.view.contentDOM.getAttribute('autocapitalize'),'off');
      assert.equal(editor.text(),'한글 hello');
    }
  }finally{editor.destroy();}
  const standalone=new DocumentEditor(root());try{
    standalone.configure({spellcheck:true});assert.equal(standalone.view.contentDOM.getAttribute('spellcheck'),'true');
    standalone.configure({spellcheck:false});assert.equal(standalone.view.contentDOM.getAttribute('spellcheck'),'false');
  }finally{standalone.destroy();}
});

test('English UI routes even short Korean content to Korean proofreading without native duplicate marks',async()=>{
  for(const source of ['한','한글','ㅎ']){
    const messages=host(source,language=>language==='en'?{...empty(language),issues:[{from:0,to:source.length,kind:'spelling',message:'Wrong dictionary',suggestions:[]}]}:empty(language)),app=await mountApp(root());try{
      await until(()=>!!app.editor.view.state.field(proofreadingState).result.language);
      assert.equal(app.root.lang,'en');assert.deepEqual(messages.filter(m=>m.method==='proofread').map(m=>m.args.language),['ko'],source);
      assert.equal(app.editor.view.contentDOM.getAttribute('spellcheck'),'false');assert.equal(app.editor.view.state.field(proofreadingState).issues.length,0);
      assert.equal(app.root.querySelector('.mori-spelling'),null);assert.equal(app.editor.text(),source);assert.equal(app.documents.get('spelling')!.text,source);
    }finally{app.destroy();}
  }
});

test('Korean UI does not route short English words to the Korean checker',async()=>{
  const source='hi',messages=host(source,language=>empty(language),{language:'ko'}),app=await mountApp(root());try{
    await until(()=>!!app.editor.view.state.field(proofreadingState).result.language);
    assert.equal(app.root.lang,'ko');assert.deepEqual(messages.filter(m=>m.method==='proofread').map(m=>m.args.language),['en']);
    assert.equal(app.editor.view.state.field(proofreadingState).issues.length,0);assert.equal(app.editor.text(),source);
  }finally{app.destroy();}
});

test('mixed prose uses English spelling verdicts without retaining Korean false positives for valid English',async()=>{
  const source='😀 한국어 hello wrng 할수있어요 됬어요';
  const issue=(word:string,kind='spelling',suggestions:string[]=[])=>({from:source.indexOf(word),to:source.indexOf(word)+word.length,kind,message:'Check',suggestions});
  const messages=host(source,language=>({...empty(language),issues:language==='ko'?[issue('hello'),issue('wrng'),issue('할수있어요','grammar',['할 수 있어요']),issue('됬어요','spelling',['됐어요'])]:[issue('한국어'),issue('wrng','spelling',['wrong'])]}));
  const app=await mountApp(root());try{
    await until(()=>app.editor.view.state.field(proofreadingState).issues.length>0);
    const checked=app.editor.view.state.field(proofreadingState).issues;
    assert.deepEqual(checked.map(i=>[source.slice(i.from,i.to),i.kind,i.suggestions]),[['wrng','spelling',['wrong']],['할수있어요','grammar',['할 수 있어요']],['됬어요','spelling',['됐어요']]]);
    assert.deepEqual([...app.root.querySelectorAll('.cm-content .mori-spelling')].map(mark=>mark.textContent),['wrng','됬어요']);
    assert.deepEqual(messages.filter(m=>m.method==='proofread').map(m=>m.args.language),['ko','en']);
    assert.equal(app.editor.text(),source);assert.equal(app.documents.get('spelling')!.text,source);
  }finally{app.destroy();}
});

test('spellcheck toggle controls custom spelling while grammar remains available and source stays unchanged',async()=>{
  const source='됬어요 할수있어요',messages=host(source,language=>({...empty(language),issues:[{from:0,to:3,kind:'spelling',message:'Spelling',suggestions:['됐어요']},{from:4,to:9,kind:'grammar',message:'Spacing',suggestions:['할 수 있어요']}]}));
  const app=await mountApp(root());try{
    await until(()=>app.editor.view.state.field(proofreadingState).issues.length===2);
    assert.ok(app.root.querySelector('.mori-spelling'));assert.equal(app.editor.view.contentDOM.getAttribute('spellcheck'),'false');
    await app.action('settings');change('spellcheck',false);
    await until(()=>app.editor.view.state.field(proofreadingState).issues.length===1);
    assert.equal(app.root.querySelector('.mori-spelling'),null);assert.ok(app.root.querySelector('.mori-grammar'));
    change('spellcheck',true);await until(()=>app.editor.view.state.field(proofreadingState).issues.length===2);
    assert.ok(app.root.querySelector('.mori-spelling'));assert.ok(messages.filter(m=>m.method==='proofread').length>=3);
    assert.equal(app.editor.text(),source);assert.equal(app.documents.get('spelling')!.text,source);
  }finally{app.destroy();}
});

test('disabling all checks clears cached preview marks and stops the custom service',async()=>{
  const source='됬어요\n\n정상 문단',messages=host(source,language=>({...empty(language),issues:[{from:0,to:3,kind:'spelling',message:'Spelling',suggestions:['됐어요']}]}),{grammarCheck:false});
  const app=await mountApp(root());try{
    app.editor.select({from:source.length,to:source.length});
    await until(()=>!!app.root.querySelector('.live-block .mori-spelling'));
    app.editor.view.dispatch({changes:{from:source.length,insert:'!'}});
    await app.action('settings');change('spellcheck',false);
    assert.equal(app.root.querySelector('.live-block .mori-spelling'),null,'cached preview marks must clear with the setting');
    const calls=messages.filter(m=>m.method==='proofread').length;await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(messages.filter(m=>m.method==='proofread').length,calls);
    app.setMode('reading');assert.equal(app.root.querySelector('.reading .mori-spelling'),null);
    assert.equal(app.editor.view.contentDOM.getAttribute('spellcheck'),'false');assert.equal(app.editor.text(),source+'!');
  }finally{app.destroy();}
});
