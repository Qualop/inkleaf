import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { NativeClient, normalizeSnapshot } from '../client/bridge.ts';
import { mountApp } from '../client/app.ts';
const dom = new JSDOM('<!doctype html><html><body><div id="image-tests"></div></body></html>', { url:pathToFileURL(new URL('../dist/index.html',import.meta.url).pathname).href,pretendToBeVisual:true,runScripts:'dangerously',resources:{interceptors:[requestInterceptor(request=>{if(!request.url.startsWith('file:'))throw new Error('Network requests are forbidden in media tests');})]},virtualConsole:new VirtualConsole() });
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



// jsdom supplies no SVG layout; the real renderer receives deterministic local geometry.
(win.SVGElement.prototype as any).getBBox=function(){return {x:0,y:0,width:Math.max(40,(this.textContent?.length ?? 0)*8),height:20};};
(win.SVGElement.prototype as any).getComputedTextLength=function(){return (this.textContent?.length ?? 0)*8;};
(win.SVGElement.prototype as any).getTotalLength=function(){return 100;};
const fixture={...snapshot,path:'/notes/n.md',savedDigest:'disk',text:'before $x+1$ after `code $z$`\n\n$$y=2$$\n\n```math\r\na+b\r\n```'};
function host(){const messages:any[]=[];transport(message=>{messages.push(message);queueMicrotask(()=>reply(message.id,({bootstrap:{settings:{language:'en',mathNumbering:'all'},recoveries:[]},createDocument:fixture,settings:{},checkpoint:{},clipboard:{},export:{path:'/notes/equation.svg'}} as any)[message.method] ?? {}));});return messages;}
test('selected inline, dollar block and fenced math copy exact TeX and reject code examples',async()=>{
  const messages=host(),app=await mountApp(root());try{
    for(const [needle,expected] of [['x+1','x+1'],['y=2','y=2'],['a+b','a+b\n']]){const position=fixture.text.indexOf(needle);app.editor.select({from:position,to:position});await app.action('copy-math-tex');assert.equal(messages.filter(m=>m.method==='clipboard').at(-1).args.text,expected);}
    const code=fixture.text.indexOf('$z$');app.editor.select({from:code,to:code});await assert.rejects(app.action('copy-math-tex'),/select|math|formula/i);
  }finally{app.destroy();}
});
test('selected equation converts with real local MathJax and copies MathML/SVG then saves immutable SVG',async()=>{
  const messages=host(),app=await mountApp(root());try{
    const position=fixture.text.indexOf('y=2');app.editor.select({from:position,to:position});
    await app.action('copy-math-mathml');const mathml=messages.filter(m=>m.method==='clipboard').at(-1).args;assert.match(mathml.html,/<math.*MathML/);assert.equal(mathml.text,mathml.html);assert.match(mathml.html,/\(1\)/);
    await app.action('copy-math-svg');const svg=messages.filter(m=>m.method==='clipboard').at(-1).args;assert.match(svg.text,/^<svg/);assert.equal(svg.type,'image/svg+xml');assert.ok(svg.base64);
    await app.action('save-math-svg');const saved=messages.find(m=>m.method==='export').args;assert.equal(saved.assetKind,'svg');assert.match(saved.content,/^<svg/);assert.equal(app.editor.text(),fixture.text);
  }finally{app.destroy();}
});
test('selected diagram saves a real standalone local Mermaid SVG',async()=>{
  const messages=host(),app=await mountApp(root());try{
    const source='```mermaid\nflowchart LR\nA[Start] --> B[End]\n```';app.editor.replace(source);app.editor.select({from:source.indexOf('A['),to:source.indexOf('A[')});await app.action('save-diagram-svg');
    const saved=messages.find(m=>m.method==='export').args;assert.equal(saved.assetKind,'svg');assert.match(saved.content,/^<svg/);assert.match(saved.content,/Start/);assert.equal(app.editor.text(),source);
  }finally{app.destroy();dom.window.close();}
});
