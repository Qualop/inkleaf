import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openImageDialog } from '../client/image-dialog.ts';
import type { ImageDialogOptions } from '../client/image-dialog.ts';

function fixture(source:string,selection={from:source.indexOf('![')+2,to:source.indexOf('![')+2},extras:Partial<ImageDialogOptions>={}) {
  const dom=new JSDOM('<div id="root"></div>',{url:'https://mori.local/'}),win=dom.window,root=win.document.getElementById('root')!;
  for(const name of ['window','document','Event','HTMLElement','HTMLInputElement'])Object.defineProperty(globalThis,name,{value:name==='window'?win:(win as any)[name],configurable:true,writable:true});
  const applied:any[]=[];let current=true;
  openImageDialog(root,{source,selection,isCurrent:()=>current,apply:(text,range)=>applied.push({text,range}),...extras});
  const query=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const property=(key:string,value:string)=>{const control=query<HTMLInputElement>(`[data-image-property="${key}"]`);control.value=value;control.dispatchEvent(new win.Event('input',{bubbles:true}));};
  const apply=()=>query<HTMLButtonElement>('[data-image-apply]').click();
  return {dom,win,root,applied,query,property,apply,stale:()=>{current=false;},cleanup:()=>dom.window.close()};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('Markdown alt and title edits retain original URL syntax and untouched surrounding source',()=>{
  const f=fixture('pre ![old](<assets/a b.png> "before")\r\n`![code](x.png)`');try{
    f.property('alt','a [label]');f.property('title','quoted "value"');f.apply();
    assert.deepEqual(f.applied,[{text:'pre ![a \\[label\\]](<assets/a b.png> "quoted \\"value\\"")\r\n`![code](x.png)`',range:{from:4,to:55}}]);
  }finally{f.cleanup();}
});
test('dimensional Markdown images become HTML with a visible explanation and one callback',()=>{
  const f=fixture('before ![old](a.png "tip") after');try{
    f.property('alt','A & B');f.property('width','320');f.property('height','200');assert.equal(f.query<HTMLElement>('[data-image-conversion]').hidden,false);assert.match(f.query('[data-image-conversion]').textContent!,/HTML.*width.*height/i);
    const apply=f.query<HTMLButtonElement>('[data-image-apply]');apply.click();apply.click();
    assert.deepEqual(f.applied,[{text:'before <img src="a.png" alt="A &amp; B" title="tip" width="320" height="200"> after',range:{from:7,to:77}}]);
  }finally{f.cleanup();}
});
test('HTML property edits preserve other attributes and their exact quoting and whitespace',()=>{
  const source="pre <IMG class='wide' src=\"assets/a.png\" data-custom='keep &amp; raw' alt='old' width='90' loading=lazy /> after",f=fixture(source,{from:7,to:7});try{
    assert.equal(f.query<HTMLInputElement>('[data-image-property="width"]').value,'90');f.property('alt',"new 'label'");f.property('title','tip & quote');f.property('width','');f.property('height','40');f.apply();
    assert.equal(f.applied[0].text,"pre <IMG class='wide' src=\"assets/a.png\" data-custom='keep &amp; raw' alt='new &#39;label&#39;' loading=lazy title=\"tip &amp; quote\" height=\"40\" /> after");
  }finally{f.cleanup();}
});
test('unchanged Markdown and HTML retain their exact source bytes',()=>{
  for(const source of ['![a](<a b.png> \'title\')',"<img src='a.png' ALT='a &amp; b' title='tip' width='020' data-x='keep'>"]){const f=fixture(source,{from:2,to:2});try{f.apply();assert.equal(f.applied[0].text,source);}finally{f.cleanup();}}
});
test('invalid dimensions and stale origin cannot apply edits',()=>{
  const f=fixture('![a](a.png)');try{
    for(const value of ['0','-1','1.5','Infinity','20px','50%','32769']){f.property('width',value);f.apply();assert.equal(f.applied.length,0);assert.match(f.query('[data-image-error]').textContent!,/width|pixels/i);}
    f.property('width','120');f.stale();f.apply();assert.equal(f.applied.length,0);assert.match(f.query('[data-image-error]').textContent!,/changed|reopen/i);
  }finally{f.cleanup();}
});
test('preview zoom and fit controls never alter source properties or apply',()=>{
  const f=fixture('![a](https://example.invalid/a.png)');try{
    f.query<HTMLButtonElement>('[data-image-zoom-in]').click();assert.equal(f.query('[data-image-zoom-value]').textContent,'125%');assert.equal(f.query<HTMLImageElement>('[data-image-preview]').style.transform,'scale(1.25)');
    f.query<HTMLButtonElement>('[data-image-zoom-out]').click();assert.equal(f.query('[data-image-zoom-value]').textContent,'100%');f.query<HTMLButtonElement>('[data-image-fit]').click();assert.equal(f.query('[data-image-zoom-value]').textContent,'Fit');
    assert.equal(f.applied.length,0);assert.equal(f.query<HTMLInputElement>('[data-image-property="width"]').value,'');f.apply();assert.equal(f.applied[0].text,'![a](https://example.invalid/a.png)');
  }finally{f.cleanup();}
});
test('local preview reads only inside its root and reports real loading, load and error events',async()=>{
  const reads:any[]=[];let resolve!:(value:{type:string;base64:string})=>void;
  const f=fixture('![a](assets/a%20b.png)',undefined,{assetRoot:'/notes',readAsset:(path,root)=>{reads.push({path,root});return new Promise(done=>{resolve=done;});}});try{
    assert.deepEqual(reads,[{path:'/notes/assets/a b.png',root:'/notes'}]);assert.match(f.query('[data-image-preview-status]').textContent!,/Loading/);
    resolve({type:'image/png',base64:'AA=='});await tick();const image=f.query<HTMLImageElement>('[data-image-preview]');assert.equal(image.getAttribute('src'),'data:image/png;base64,AA==');assert.match(f.query('[data-image-preview-status]').textContent!,/Loading/);
    image.dispatchEvent(new f.win.Event('load'));assert.match(f.query('[data-image-preview-status]').textContent!,/loaded/i);image.dispatchEvent(new f.win.Event('error'));assert.match(f.query('[data-image-preview-status]').textContent!,/could not|unavailable/i);
  }finally{f.cleanup();}
  const escaped=fixture('![a](../outside.png)',undefined,{assetRoot:'/notes',readAsset:async()=>{assert.fail('outside root read');return {type:'image/png',base64:''};}});try{await tick();assert.match(escaped.query('[data-image-preview-status]').textContent!,/outside.*root/i);}finally{escaped.cleanup();}
});
test('Image Properties preview treats hash and percent directory names as literal filesystem paths',async()=>{
  for(const root of ['/notes #1/100%','/C:/notes #1/100%','/UNC/server/share/notes #1/100%']){
    const reads:any[]=[];const f=fixture('![a](assets/a%20b.png)',undefined,{assetRoot:root,readAsset:async(path,assetRoot)=>{reads.push({path,root:assetRoot});return {type:'image/png',base64:'AA=='};}});
    try{
      await tick();assert.equal(f.query<HTMLImageElement>('[data-image-preview]').getAttribute('src'),'data:image/png;base64,AA==');
      assert.deepEqual(reads,[{path:root+'/assets/a b.png',root}]);
    }finally{f.cleanup();}
  }
});
test('preview failures and late local replies cannot mutate a closed dialog',async()=>{
  const failed=fixture('![a](a.png)',undefined,{assetRoot:'/notes',readAsset:async()=>{throw new Error('missing fixture image');}});try{await tick();assert.match(failed.query('[data-image-preview-status]').textContent!,/missing fixture image/);}finally{failed.cleanup();}
  let resolve!:(value:{type:string;base64:string})=>void;const f=fixture('![a](a.png)',undefined,{assetRoot:'/notes',readAsset:()=>new Promise(done=>{resolve=done;})});try{
    const image=f.query<HTMLImageElement>('[data-image-preview]');f.query<HTMLButtonElement>('dialog header button').click();resolve({type:'image/png',base64:'AA=='});await tick();assert.equal(image.hasAttribute('src'),false);assert.equal(f.applied.length,0);
  }finally{f.cleanup();}
});
test('empty, multiple and code-only selections show a safe message without an apply action',()=>{
  for(const [source,selection] of [['plain text',{from:0,to:0}],['![a](a.png) ![b](b.png)',{from:0,to:25}],['`![a](a.png)`',{from:4,to:4}]] as const){const f=fixture(source,selection);try{assert.match(f.query('dialog').textContent!,/exactly one.*image/i);assert.equal(f.root.querySelector('[data-image-apply]'),null);assert.equal(f.applied.length,0);}finally{f.cleanup();}}
});

test('new Markdown alternative text escapes formatting and HTML delimiters as literal text',()=>{
  const f=fixture('![before](a.png)');try{f.property('alt','*plain* <tag>');f.apply();assert.equal(f.applied[0].text,'![\\*plain\\* \\<tag\\>](a.png)');}finally{f.cleanup();}
});
