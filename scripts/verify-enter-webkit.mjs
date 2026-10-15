import {build} from 'esbuild';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import path from 'node:path';

// Real WebKit layout probe. Exit 1 means a regression; exit 2 means the harness failed.
const {values} = parseArgs({options: {label: {type: 'string', default: 'probe'}, cases: {type: 'string'},
  width: {type: 'string', default: '1080'}, height: {type: 'string', default: '760'}}});
const root = path.resolve(import.meta.dirname, '..');
const cache = path.join(root, '.cache/enter-webkit');
const directory = path.join(cache, `${values.label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}-${process.pid}`);
await mkdir(directory, {recursive: true});
const env = {...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
  CLANG_MODULE_CACHE_PATH: path.join(cache, 'clang'), SWIFTPM_MODULECACHE_OVERRIDE: path.join(cache, 'swift')};
const fingerprints = async () => Object.fromEntries(await Promise.all(['web/client/editor.ts', 'web/client/live.ts', 'web/render/markdown.ts', 'web/core/source.ts', 'web/style.css'].map(async file =>
  [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const before = await fingerprints();

const fixture = String.raw`
import {DocumentEditor} from __EDITOR__;
import {Transaction} from '@codemirror/state';
import __STYLE__;
const host = document.getElementById('editor');
let editor;
const failures = [], browserErrors = [];
window.addEventListener('error', event => browserErrors.push(String(event.error?.stack ?? event.message)));
window.addEventListener('unhandledrejection', event => browserErrors.push(String(event.reason?.stack ?? event.reason)));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const rect = value => value ? {top:value.top,bottom:value.bottom,left:value.left,right:value.right,
  width:value.width??value.right-value.left,height:value.height??value.bottom-value.top} : null;
const cases = [
  {id:'plain-multiline', text:'첫째\n둘째', tokens:['첫째','둘째'], twoRows:true, exact:true},
  {id:'plain-single', text:'한글 문단', tokens:['한글 문단'], exact:true},
  {id:'tight-list-multiline', text:'- 첫째\n  둘째\n\n바깥 문단', tokens:['첫째','둘째'], twoRows:true},
  {id:'quote-multiline', text:'> 첫째\n> 둘째\n\n바깥 문단', tokens:['첫째','둘째'], twoRows:true},
  {id:'heading-plain', text:'## 제목\n\n첫째\n둘째', tokens:['첫째','둘째'], twoRows:true, exact:true},
  {id:'heading-only', text:'## 제목', tokens:['제목'], exact:true},
  {id:'list-enter', text:'- 목록', tokens:['목록']},
  {id:'list-separator', text:'- 목록\n\n다음', tokens:['목록','다음']},
  {id:'ordered-separator', text:'1. 목록\n\n다음', tokens:['목록','다음']},
  {id:'quote-separator', text:'> 인용\n\n다음', tokens:['인용','다음']},
  {id:'bottom-multiline', text:Array.from({length:65}, (_, i) => '문단 '+(i+1)+'의 첫 줄\n문단 '+(i+1)+'의 둘째 줄').join('\n\n')+'\n\n마지막 첫째\n마지막 둘째', tokens:['마지막 첫째','마지막 둘째'], twoRows:true, exact:true, bottom:true}
];
function check(condition, rule, detail) { if (!condition) failures.push({rule, ...detail}); }
function tokenRects(token) {
  const walker = document.createTreeWalker(editor.view.contentDOM, NodeFilter.SHOW_TEXT), found = [];
  while (walker.nextNode()) {
    const node = walker.currentNode; let offset = node.textContent.indexOf(token);
    if (offset < 0) continue;
    const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset+token.length);
    found.push({rects:[...range.getClientRects()].map(rect), parent:node.parentElement?.outerHTML});
  }
  return found;
}
function measure() {
  const view = editor.view, selection = view.state.selection.main;
  const lines = [...view.contentDOM.querySelectorAll('.cm-line')].map(element => {
    let from=null, number=null;
    try { from=view.posAtDOM(element, 0); number=view.state.doc.lineAt(from).number; } catch {}
    const style=getComputedStyle(element);
    return {from, number, text:element.textContent, html:element.outerHTML, rect:rect(element.getBoundingClientRect()),
      active:element.classList.contains('cm-activeLine'), blank:element.textContent==='', lineHeight:style.lineHeight, whiteSpace:style.whiteSpace};
  });
  const scroller=view.scrollDOM, scrollerRect=rect(scroller.getBoundingClientRect());
  const blanks=[];
  for (let n=1;n<=view.state.doc.lines;n++) {
    const line=view.state.doc.line(n); if (line.text!=='') continue;
    const block=view.lineBlockAt(line.from), top=view.documentTop+block.top;
    if (top+block.height < scrollerRect.top || top>scrollerRect.bottom) continue;
    blanks.push({number:n, from:line.from, block:{from:block.from,to:block.to,type:block.type,top,height:block.height},
      rendered:lines.find(item=>item.number===n)??null});
  }
  return {text:editor.text(), cmText:view.state.doc.toString(), selection:{anchor:selection.anchor,head:selection.head},
    sourceSelection:editor.selection(), caret:rect(view.coordsAtPos(selection.head)),
    cursors:[...view.dom.querySelectorAll('.cm-cursor')].map(element=>rect(element.getBoundingClientRect())),
    scroller:{top:scroller.scrollTop,left:scroller.scrollLeft,height:scroller.scrollHeight,clientHeight:scroller.clientHeight,rect:scrollerRect},
    windowScroll:{x:window.scrollX,y:window.scrollY}, contentHeight:view.contentHeight, defaultLineHeight:view.defaultLineHeight,
    contentLineHeight:getComputedStyle(view.contentDOM).lineHeight, activeElement:document.activeElement?.className,
    lines, blanks, widgets:[...view.contentDOM.querySelectorAll('.live-block')].map(element=>({html:element.outerHTML,rect:rect(element.getBoundingClientRect())})),
    viewport:{...view.viewport}, visibleRanges:view.visibleRanges.map(range=>({...range}))};
}
async function settle() {
  let previous='', unchanged=0;
  for (let i=0;i<90;i++) {
    await frame();
    const value=measure(), signature=JSON.stringify([value.selection,value.caret,value.scroller,value.contentHeight,value.lines,value.widgets]);
    if (signature===previous) unchanged++; else unchanged=0;
    previous=signature;
    if (unchanged>=3) return {frames:i+1,stable:true};
  }
  return {frames:90,stable:false};
}
async function snapshot(item, mode, stage, expectCaretVisible=true) {
  const settled=await settle(), data={stage,...measure(),tokens:Object.fromEntries(item.tokens.map(token=>[token,tokenRects(token)])),settled};
  const where={case:item.id,mode,stage};
  check(settled.stable,'layout-did-not-settle',where);
  check(data.text===data.cmText,'source-model-diverged',where);
  const caret=data.caret, scroll=data.scroller.rect, epsilon=1/window.devicePixelRatio;
  check(caret && caret.height!==0 && Number.isFinite(caret.top),'caret-missing',where);
  if (expectCaretVisible) {
    check(caret && caret.top>=scroll.top-epsilon && caret.bottom<=scroll.bottom+epsilon,'caret-outside-viewport',{...where,caret,scroll});
    check(caret && data.cursors.some(cursor=>Math.abs(cursor.top-caret.top)<=epsilon && Math.abs(cursor.bottom-caret.bottom)<=epsilon &&
      caret.left>=cursor.left-epsilon && caret.left<=cursor.right+epsilon),'drawn-cursor-disagrees-with-selection',{...where,caret,cursors:data.cursors});
  }
  const active=data.lines.find(line=>line.active);
  if (active && caret) check(caret.top>=active.rect.top-epsilon && caret.bottom<=active.rect.bottom+epsilon,'caret-outside-active-line',{...where,caret,line:active.rect});
  for (const blank of data.blanks) {
    check(blank.block.type===0,'blank-separator-hidden-by-widget',{...where,blank});
    if (blank.rendered) check(blank.rendered.rect.height+epsilon>=data.defaultLineHeight,'blank-line-compressed',
      {...where,line:blank.number,height:blank.rendered.rect.height,plainLineHeight:data.defaultLineHeight});
  }
  if (item.twoRows) {
    const first=data.tokens[item.tokens[0]][0]?.rects[0], second=data.tokens[item.tokens[1]][0]?.rects[0];
    if (first && second) check(second.top>=first.bottom-epsilon,'paragraph-linebreak-collapsed',{...where,first,second});
    else if (expectCaretVisible)
      check(false,'tracked-paragraph-not-rendered',{...where,tokens:data.tokens});
  }
  return data;
}
function enter() {
  editor.view.focus();
  const event=new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true});
  const before=editor.text(); editor.view.contentDOM.dispatchEvent(event);
  return {prevented:event.defaultPrevented,changed:before!==editor.text()};
}
function insert(text) {
  editor.view.dispatch({...editor.view.state.replaceSelection(text),annotations:Transaction.userEvent.of('input.type'),scrollIntoView:true});
}
async function runCase(item, mode) {
  editor?.destroy(); host.replaceChildren();
  editor=new DocumentEditor(host); window.enterProbe.editor=editor;
  editor.open({documentId:'synthetic-'+item.id+'-'+mode,path:null,text:item.text,revision:0,savedDigest:null,encoding:'utf8',lineEnding:'LF'});
  editor.mode(mode); editor.select({from:item.text.length,to:item.text.length});
  const snapshots=[await snapshot(item,mode,'initial')], inputs=[];
  for (let n=1;n<=2;n++) {
    const input=enter(); inputs.push(input); check(input.prevented&&input.changed,'enter-not-handled-by-keymap',{case:item.id,mode,n,input});
    snapshots.push(await snapshot(item,mode,'enter'+n));
  }
  const tail='새 문단 입력'; insert(tail); snapshots.push(await snapshot(item,mode,'typed'));
  const typed=editor.text(), separator=item.text.lastIndexOf('\n\n'), previous=separator<0?0:separator+2;
  editor.select({from:previous,to:previous}); snapshots.push(await snapshot(item,mode,'select-previous'));
  editor.select({from:typed.length,to:typed.length}); snapshots.push(await snapshot(item,mode,'select-tail'));
  if (item.bottom) {
    const before=editor.view.scrollDOM.scrollTop;
    editor.view.scrollDOM.scrollTop=(editor.view.scrollDOM.scrollHeight-editor.view.scrollDOM.clientHeight)/2;
    const middle=await snapshot(item,mode,'scroll-middle',false); snapshots.push(middle);
    check(middle.text===typed && middle.selection.head===typed.length && middle.scroller.top<before,'scroll-changed-model-or-did-not-move',{case:item.id,mode});
    editor.select({from:typed.length,to:typed.length}); snapshots.push(await snapshot(item,mode,'return-to-tail'));
  }
  check(editor.text()===typed,'selection-changed-text',{case:item.id,mode});
  if (item.exact) {
    for (let n=1;n<=2;n++) {
      check(snapshots[n].text===item.text+'\n'.repeat(n),'enter-newline-not-preserved',{case:item.id,mode,n,text:snapshots[n].text});
      check(snapshots[n].selection.anchor===item.text.length+n && snapshots[n].selection.head===item.text.length+n,'enter-selection-wrong',{case:item.id,mode,n,selection:snapshots[n].selection});
    }
    check(snapshots[3].text===item.text+'\n\n'+tail,'typing-changed-newlines',{case:item.id,mode,text:snapshots[3].text});
  }
  if (item.bottom) check(snapshots[0].scroller.top>0 && snapshots[0].scroller.height>snapshots[0].scroller.clientHeight,'bottom-fixture-not-scrolled',{case:item.id,mode});
  return {mode,inputs,snapshots};
}
window.enterProbe={editor:null,measure,enter,insert,run:async()=>{
  try {
    await document.fonts.ready;
    const selected=__CASES__, results=[];
    for (const item of cases.filter(item=>!selected || selected.includes(item.id))) {
      check(!item.text.includes(String.fromCharCode(92)+'n'),'fixture-has-literal-newline-escape',{case:item.id});
      if(item.twoRows) check(item.text.includes('\n'),'multiline-fixture-has-no-newline',{case:item.id});
      const source=await runCase(item,'source'), live=await runCase(item,'live');
      for (let i=0;i<source.snapshots.length;i++) {
        const a=source.snapshots[i], b=live.snapshots[i];
        check(a.text===b.text && JSON.stringify(a.selection)===JSON.stringify(b.selection),'live-source-model-or-selection-mismatch',{case:item.id,stage:a.stage});
        if (item.twoRows) {
          const gap=snapshot=>{const first=snapshot.tokens[item.tokens[0]][0]?.rects[0],second=snapshot.tokens[item.tokens[1]][0]?.rects[0];return first&&second?second.top-first.top:null;};
          const sourceGap=gap(a),liveGap=gap(b);
          if(sourceGap!==null && liveGap!==null) check(Math.abs(sourceGap-liveGap)<=1/devicePixelRatio,'live-source-paragraph-line-spacing-mismatch',{case:item.id,stage:a.stage,sourceGap,liveGap});
        }
      }
      results.push({id:item.id,initialText:item.text,source,live});
    }
    const result={engine:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},results,failures,browserErrors};
    window.__enterResult=JSON.stringify(result);
  } catch(error) { window.__enterResult=JSON.stringify({fatal:String(error?.stack??error),failures,browserErrors}); }
}};
`.replace('__EDITOR__',JSON.stringify(path.join(root,'web/client/editor.ts')))
  .replace('__STYLE__',JSON.stringify(path.join(root,'web/style.css')))
  .replace('__CASES__',JSON.stringify(values.cases?.split(',')??null));
await writeFile(path.join(directory,'fixture.js'),fixture);
await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'enter-webkit-fixture.js'},bundle:true,format:'iife',target:'safari17.4',
  outfile:path.join(directory,'probe.js'),logLevel:'warning',sourcemap:true});
await writeFile(path.join(directory,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>/* Keep synthetic cursor geometry measurable when the OS changes key-window focus. */ .cm-cursorLayer .cm-cursor{display:block!important}.cm-cursorLayer{animation:none!important}</style></head><body><div id="app" class="mori-app" data-theme="light"><main class="workspace"><section class="document-area"><div class="editor-host" id="editor"></div></section></main></div><script src="probe.js"></script></body></html>');

const swift = String.raw`
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate {
    let directory: URL
    let window: NSWindow
    let webView: WKWebView
    var finished = false
    init(directory: URL, width: Double, height: Double) {
        self.directory = directory
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x:0,y:0,width:width,height:height), configuration:configuration)
        window = NSWindow(contentRect:webView.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        super.init()
        window.title = "Inkleaf synthetic Enter layout probe"
        window.contentView = webView
        window.isReleasedWhenClosed = false
        webView.navigationDelegate = self
    }
    func start() {
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(webView)
        webView.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo:directory)
        Task { try? await Task.sleep(for:.seconds(120)); finish(error:"Native probe timed out") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            do {
                let ready = try await webView.evaluateJavaScript("Boolean(window.enterProbe && (window.enterProbe.run(), true))")
                guard (ready as? Bool) == true else { finish(error:"Fixture did not initialize"); return }
                while !finished {
                    if let result = try await webView.evaluateJavaScript("window.__enterResult ?? null") as? String {
                        try result.write(to:directory.appendingPathComponent("result.json"),atomically:true,encoding:.utf8)
                        finished = true; window.close(); exit(0)
                    }
                    try await Task.sleep(for:.milliseconds(40))
                }
            } catch { finish(error:String(describing:error)) }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(error:String(describing:error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(error:String(describing:error)) }
    func finish(error: String) {
        guard !finished else { return }; finished = true
        let bytes = try? JSONSerialization.data(withJSONObject:["fatal":error],options:[.prettyPrinted,.sortedKeys])
        try? bytes?.write(to:directory.appendingPathComponent("result.json"))
        window.close(); exit(2)
    }
}
@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        let arguments = CommandLine.arguments
        let runner = Probe(directory:URL(fileURLWithPath:arguments[1],isDirectory:true),width:Double(arguments[2])!,height:Double(arguments[3])!)
        runner.start(); withExtendedLifetime(runner) { app.run() }
    }
}
`;
await writeFile(path.join(directory,'Probe.swift'),swift);
async function execute(command,args,timeout) {
  const log = [];
  const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',bytes=>log.push(bytes)); child.stderr.on('data',bytes=>log.push(bytes));
  const timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??2));}).finally(()=>clearTimeout(timer));
  await writeFile(path.join(directory,command==='swiftc'?'compile.log':'native.log'),Buffer.concat(log));
  if(code!==0 && command==='swiftc') throw new Error(Buffer.concat(log).toString());
  return code;
}
try {
  await execute('swiftc',['-parse-as-library','-swift-version','6',path.join(directory,'Probe.swift'),'-o',path.join(directory,'probe')],120_000);
  const nativeExit=await execute(path.join(directory,'probe'),[directory,values.width,values.height],130_000);
  const report=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
  report.sources={before,after:await fingerprints()};
  report.sourceChangedDuringRun=JSON.stringify(report.sources.before)!==JSON.stringify(report.sources.after);
  report.nativeExit=nativeExit;
  await writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2)+'\n');
  const summary={directory,nativeExit,cases:report.results?.length??0,failures:report.failures?.length??0,
    rules:Object.fromEntries([...new Set(report.failures?.map(item=>item.rule)??[])].map(rule=>[rule,report.failures.filter(item=>item.rule===rule).length])),
    fatal:report.fatal,browserErrors:report.browserErrors,sourceChangedDuringRun:report.sourceChangedDuringRun};
  await writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
  process.exitCode=report.fatal||nativeExit!==0||report.sourceChangedDuringRun||report.browserErrors?.length||!report.results?.length ? 2 : report.failures.length ? 1 : 0;
} catch(error) { console.error(error);console.error('Probe artifacts: '+directory);process.exitCode=2; }
