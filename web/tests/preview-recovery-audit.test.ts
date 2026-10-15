import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole,requestInterceptor} from 'jsdom';
import {pathToFileURL} from 'node:url';
import {typesetPreviews,clearPreviewCache} from '../render/previews.ts';
import {renderMarkdown} from '../render/markdown.ts';

const dom=new JSDOM('<!doctype html><main></main>',{
  url:pathToFileURL(new URL('../dist/index.html',import.meta.url).pathname).href,
  runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:new VirtualConsole(),
  resources:{interceptors:[requestInterceptor(request=>{if(!request.url.startsWith('file:'))throw Error('Unexpected network resource');})]},
});
const win=dom.window;
globalThis.window=win as any;globalThis.document=win.document;
(win as any).matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
(win.SVGElement.prototype as any).getBBox=function(){return{x:0,y:0,width:Math.max(40,(this.textContent?.length??0)*8),height:20};};
(win.SVGElement.prototype as any).getComputedTextLength=function(){return(this.textContent?.length??0)*8;};
(win.SVGElement.prototype as any).getTotalLength=()=>100;

test('failed Mermaid rendering leaves no global error SVG and a corrected diagram recovers',async()=>{
  const root=document.querySelector('main')!;
  root.innerHTML=renderMarkdown('```mermaid\nthis is invalid\n```');
  await typesetPreviews(root);
  assert.ok(root.querySelector('.preview-error'));
  assert.match(root.textContent!,/this is invalid/);
  assert.equal([...document.body.children].filter(element=>element!==root).length,0,'Mermaid error output must not escape the editor into document.body');
  root.innerHTML=renderMarkdown('```mermaid\nflowchart LR\nA[Start]-->B[End]\n```');
  await typesetPreviews(root);
  assert.equal(root.querySelector('.preview-error'),null);assert.ok(root.querySelector('svg'));
  assert.equal([...document.body.children].filter(element=>element!==root).length,0);
  const good=root.innerHTML;clearPreviewCache();await typesetPreviews(root);
  assert.ok(root.querySelector('svg'));assert.match(good,/Start/);
});
test.after(()=>dom.window.close());
