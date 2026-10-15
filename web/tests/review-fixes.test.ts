import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { undo, redo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { DocumentEditor } from '../client/editor.ts';
import { tableDialog } from '../client/table.ts';
import { mountApp } from '../client/app.ts';
import { parseTable, serializeTable, updateCell, moveColumn, moveRow, insertColumn, removeColumn, insertRow, removeRow, setAlignment } from '../core/tables.ts';
import { getOutline } from '../core/statistics.ts';
import { renderMarkdown, markdownBlocks, exportHTML } from '../render/markdown.ts';
import { COMMANDS } from '../core/commands.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mori.local/', pretendToBeVisual: true });
const win = dom.window;
for (const key of ['window', 'Window', 'Document', 'document', 'HTMLElement', 'Element', 'Node', 'Text', 'MutationObserver', 'DOMRect', 'Range', 'Event', 'KeyboardEvent', 'MouseEvent', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'AbortController', 'AbortSignal', 'DOMParser']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? win : (win as any)[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, key, { value: (win as any)[key].bind(win), configurable: true });
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON() { return {}; } });
(win.Range.prototype as any).getBoundingClientRect = rect;
(win.Range.prototype as any).getClientRects = () => [];
win.HTMLElement.prototype.getBoundingClientRect = rect;
win.HTMLElement.prototype.scrollIntoView = function () {};
(win as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const snapshot = { documentId: 'a', path: null, text: '', revision: 0, savedDigest: null, encoding: 'utf8', lineEnding: 'LF' };
function root() { const element = document.createElement('div'); document.body.replaceChildren(element); return element; }
function rendered(source: string) { const element = document.createElement('div'); element.innerHTML = renderMarkdown(source); return element; }
function wrapActive(editor: DocumentEditor) {
  return editor.view.state.facet(EditorView.contentAttributes).some(value => {
    const attributes = typeof value === 'function' ? value(editor.view) : value;
    return attributes?.class?.split(/\s+/).includes('cm-lineWrapping');
  });
}
function checkPreferences(editor: DocumentEditor, wrap: boolean, numbers: boolean) {
  assert.equal(wrapActive(editor), wrap);
  assert.equal(editor.view.contentDOM.classList.contains('cm-lineWrapping'), wrap);
  assert.equal(!!editor.view.dom.querySelector('.cm-lineNumbers'), numbers);
}

test('#4 parser accepts the renderer one-dash and colon delimiter grammar', () => {
  const source = '| a | b | c | d |\n| - | :- | -: | :-: |\n| one | two | three | four |';
  assert.equal(rendered(source).querySelectorAll('tbody td').length, 4);
  assert.deepEqual(parseTable(source), { headers: ['a', 'b', 'c', 'd'], rows: [['one', 'two', 'three', 'four']], alignments: [null, 'left', 'right', 'center'] });
});

test('#4 applying an untouched short-separator table retains its cells in one undoable edit', () => {
  const host = root(), editor = new DocumentEditor(host), errors: unknown[] = [];
  const source = 'Before\r\n\r\n| a | b |\r\n| - | - |\r\n| one | two |\r\n\r\nAfter';
  try {
    editor.open({ ...snapshot, text: source, lineEnding: 'CRLF' }); editor.mode('source');
    editor.select({ from: 14, to: 14 });
    tableDialog(host, editor, () => true, error => errors.push(error));
    assert.equal(host.querySelector<HTMLTextAreaElement>('[data-cell-row="0"][data-cell-col="0"]')?.value, 'one');
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')!.click();
    assert.deepEqual(errors, []);
    assert.equal(editor.text(), 'Before\r\n\r\n| a | b |\r\n| --- | --- |\r\n| one | two |\r\n\r\nAfter');
    assert.equal(undo(editor.view), true); assert.equal(editor.text(), source);
  } finally { editor.destroy(); }
});

test('#4 existing renderer table with unsupported raw backtick width is refused without replacement', () => {
  const host = root(), editor = new DocumentEditor(host), errors: unknown[] = [];
  const source = '| `a|b` | c |\n| - | - | - |\n| one | two | three |';
  try {
    assert.equal(markdownBlocks(source)[0].type, 'table'); assert.equal(parseTable(source), null);
    editor.open({ ...snapshot, text: source }); editor.mode('source');
    tableDialog(host, editor, () => true, error => errors.push(error));
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')?.click();
    assert.equal(editor.text(), source);
    assert.equal(errors.length, 1); assert.match(String(errors[0]), /table.*(?:parse|unsupported|malformed)/i);
    assert.equal(host.querySelector('[data-action="table-apply"]'), null);
  } finally { editor.destroy(); }
});

test('#4 malformed selected table is refused rather than replaced with insertion blanks', () => {
  const host = root(), editor = new DocumentEditor(host), errors: unknown[] = [];
  const source = '| a | b |\n| --- | nope |\n| one | two |';
  try {
    editor.open({ ...snapshot, text: source }); editor.mode('source'); editor.select({ from: 0, to: source.length });
    tableDialog(host, editor, () => true, error => errors.push(error));
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')?.click();
    assert.equal(editor.text(), source); assert.equal(errors.length, 1);
  } finally { editor.destroy(); }
});

test('#5 another cell edit preserves escaped Markdown source and actual literal rendering', () => {
  const source = String.raw`| a | b |
| --- | --- |
| \*literal\* | keep |`;
  const table = parseTable(source)!;
  const result = serializeTable(updateCell(table, 0, 1, 'changed'));
  assert.equal(result, String.raw`| a | b |
| --- | --- |
| \*literal\* | changed |`);
  const cells = rendered(result).querySelectorAll('td');
  assert.equal(cells[0].innerHTML, '*literal*'); assert.equal(cells[1].innerHTML, 'changed');
  assert.equal(cells[0].querySelector('em'), null);
});

test('#5 raw escape provenance follows row and column transforms without changing public cell values', () => {
  const source = String.raw`| A | B |
| --- | --- |
| \*literal\* | \_literal\_ |
| slash\\ | \\*emphasis* |`;
  const original = parseTable(source)!;
  assert.deepEqual(original.rows, [[String.raw`\*literal\*`, String.raw`\_literal\_`], ['slash\\', String.raw`\*emphasis*`]]);
  let table = moveColumn(moveRow(original, 0, 1), 0, 1);
  table = removeRow(insertRow(table, 1), 1);
  table = removeColumn(insertColumn(table, 1), 1);
  table = setAlignment(table, 0, 'right');
  assert.equal(serializeTable(table), String.raw`| B | A |
| ---: | --- |
| \\*emphasis* | slash\\ |
| \_literal\_ | \*literal\* |`);
  assert.deepEqual([...rendered(serializeTable(table)).querySelectorAll('td')].map(cell => cell.innerHTML), ['\\<em>emphasis</em>', 'slash\\', '_literal_', '*literal*']);
  assert.equal(serializeTable(original), source);
});

test('#5 escaped pipes, backticks, and backslash runs keep real renderer leaf meaning', () => {
  const source = '| A | B |\n| --- | --- |\n| \\| and \\`tick\\` | keep |\n| `a\\|b` | keep |\n| a\\\\\\|b | keep |';
  const table = updateCell(parseTable(source)!, 0, 1, 'changed');
  const result = serializeTable(table);
  assert.equal(result, '| A | B |\n| --- | --- |\n| \\| and \\`tick\\` | changed |\n| `a\\|b` | keep |\n| a\\\\\\|b | keep |');
  assert.deepEqual([...rendered(result).querySelectorAll('tr')].slice(1).map(row => row.firstElementChild!.innerHTML), ['| and `tick`', '<code>a|b</code>', 'a\\|b']);
});

test('#5 modal applies another cell edit atomically and rejects a stale document', () => {
  const host = root(), editor = new DocumentEditor(host), errors: unknown[] = [];
  const source = '| a | b |\n| --- | --- |\n| \\*literal\\* | keep |';
  try {
    editor.open({ ...snapshot, text: source }); editor.mode('source');
    tableDialog(host, editor, () => true, error => errors.push(error));
    const control = host.querySelector<HTMLTextAreaElement>('[data-cell-row="0"][data-cell-col="1"]')!;
    control.value = 'changed'; control.dispatchEvent(new Event('input'));
    assert.equal(editor.text(), source);
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')!.click();
    assert.equal(rendered(editor.text()).querySelector('td')!.innerHTML, '*literal*');
    assert.equal(undo(editor.view), true); assert.equal(editor.text(), source);
    tableDialog(host, editor, () => false, error => errors.push(error));
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')!.click();
    assert.equal(editor.text(), source); assert.match(String(errors[0]), /Document changed/);
  } finally { editor.destroy(); }
});

test('#11 preferences configured before opening apply to opened and empty new documents', () => {
  const editor = new DocumentEditor(root());
  try {
    editor.configure({ wrap: false, lineNumbers: true });
    editor.open({ ...snapshot, text: 'one\r\ntwo', lineEnding: 'CRLF' });
    checkPreferences(editor,false,false);editor.mode('source');
    checkPreferences(editor, false, true); assert.equal(editor.text(), 'one\r\ntwo');
    editor.open({ ...snapshot, documentId: 'new' });
    checkPreferences(editor, false, true); assert.equal(editor.text(), '');
  } finally { editor.destroy(); }
});

test('#11 switched saved sessions receive current partial preferences and retain source, selection, undo and redo', () => {
  const editor = new DocumentEditor(root());
  try {
    editor.open({ ...snapshot, text: 'one\r\ntwo', lineEnding: 'CRLF' }); editor.mode('source');
    editor.replace('one!\r\ntwo', { from: 4, to: 4 });
    editor.open({ ...snapshot, documentId: 'b', text: 'second' }); editor.replace('second!');
    editor.configure({ wrap: false, lineNumbers: true }); editor.configure({ wrap: true });
    editor.open({ ...snapshot, text: 'ignored snapshot' });
    checkPreferences(editor, true, true); assert.equal(editor.text(), 'one!\r\ntwo'); assert.deepEqual(editor.selection(), { from: 4, to: 4 });
    assert.equal(undo(editor.view), true); assert.equal(editor.text(), 'one\r\ntwo');
    assert.equal(redo(editor.view), true); assert.equal(editor.text(), 'one!\r\ntwo');
    editor.configure({ wrap: false }); editor.configure({ lineNumbers: false });
    editor.open({ ...snapshot, documentId: 'b', text: 'ignored' });
    checkPreferences(editor, false, false); assert.equal(editor.text(), 'second!');
    assert.equal(undo(editor.view), true); assert.equal(editor.text(), 'second');
  } finally { editor.destroy(); }
});

test('#12 renderer, outline, block previews and export TOC use same and same-1', () => {
  const source = '# Same\n\n# Same\n';
  assert.deepEqual(getOutline(source).map(heading => heading.id), ['same', 'same-1']);
  assert.equal(renderMarkdown(source), '<h1 id="same">Same</h1>\n<h1 id="same-1">Same</h1>\n');
  assert.deepEqual(markdownBlocks(source).map(block => block.html), ['<h1 id="same">Same</h1>\n', '<h1 id="same-1">Same</h1>\n']);
  const page = new JSDOM(exportHTML(source, { outline: true })).window.document;
  assert.deepEqual([...page.querySelectorAll('nav a')].map(link => link.getAttribute('href')), ['#same', '#same-1']);
});

test('#12 headings retain closing hashes, setext, Unicode underscores and combining marks while excluding fences and metadata', () => {
  const source = '---\r\nlabel: yes\r\n---\r\n# Same ##\r\n\r\nSame\r\n====\r\n\r\n```md\r\n# hidden\r\n```\r\n\r\n~~~\r\n# hidden too\r\n~~~\r\n\r\n## 한글_name e\u0301 ##\r\n\r\n# Same-1\r\n\r\n# Same\r\n';
  const ids = ['same', 'same-1', '한글_name-e\u0301', 'same-1-1', 'same-2'];
  assert.deepEqual(getOutline(source).map(heading => heading.id), ids);
  assert.deepEqual([...rendered(source).querySelectorAll('h1,h2')].map(heading => heading.id), ids);
  const page = new JSDOM(exportHTML(source, { outline: true })).window.document;
  assert.deepEqual([...page.querySelectorAll('nav a')].map(link => [link.getAttribute('href'), link.textContent]), [['#same', 'Same'], ['#same-1', 'Same'], ['#한글_name-e\u0301', '한글_name e\u0301'], ['#same-1-1', 'Same-1'], ['#same-2', 'Same']]);
});

test('#12 empty heading IDs retain canonical outline collision behavior', () => {
  assert.equal(renderMarkdown('#\n\n#\n'), '<h1 id=""></h1>\n<h1 id="-1"></h1>\n');
});

test('#12 a live link to the duplicate heading navigates to its original source range', async () => {
  const source = '# Same\n\n# Same\n\n[second](#same-1)\n\nend';
  (win as any).webkit = { messageHandlers: { native: { postMessage(message: any) {
    queueMicrotask(() => (win as any).__nativeReply({ id: message.id, ok: true, result: message.method === 'bootstrap' ? { settings: {language:"en"}, recoveries: [] } : message.method === 'createDocument' ? { ...snapshot, text: source } : {} }));
  } } } };
  const app = await mountApp(root());
  try {
    app.editor.select({ from: source.length, to: source.length }); app.editor.mode('source'); app.editor.mode('live');
    const link = document.querySelector<HTMLAnchorElement>('.live-block a[href="#same-1"]');
    assert.ok(link); link.click(); assert.deepEqual(app.editor.selection(), { from: 8, to: 14 });
  } finally { app.destroy(); delete (win as any).webkit; }
});

test('mac editing audit: replacing shorter source never leaves the caret inside an emoji',()=>{
  const editor=new DocumentEditor(root());try{
    editor.open({...snapshot,text:'ab'});editor.select({from:1,to:1});editor.replace('😀');
    assert.deepEqual(editor.selection(),{from:0,to:0});
    editor.command({type:'bold'});assert.equal(editor.text(),'****😀');
    assert.equal(undo(editor.view),true);assert.equal(editor.text(),'😀');
    assert.equal(undo(editor.view),true);assert.equal(editor.text(),'ab');assert.deepEqual(editor.selection(),{from:1,to:1});
    assert.equal(redo(editor.view),true);assert.equal(editor.text(),'😀');assert.deepEqual(editor.selection(),{from:2,to:2});
  }finally{editor.destroy();}
});

const auditSource='앞\r\n한😀글\r\n뒤';
const editingAuditCases:[string,string,any?,string?,number?,number?,string?][]=[
  ['bold','앞\r\n**한😀글**\r\n뒤',undefined,undefined,undefined,undefined,'strong'],
  ['italic','앞\r\n*한😀글*\r\n뒤',undefined,undefined,undefined,undefined,'em'],
  ['underline','앞\r\n<u>한😀글</u>\r\n뒤',undefined,undefined,undefined,undefined,'u'],
  ['strike','앞\r\n~~한😀글~~\r\n뒤',undefined,undefined,undefined,undefined,'s'],
  ['highlight','앞\r\n==한😀글==\r\n뒤',undefined,undefined,undefined,undefined,'mark'],
  ['sup','앞\r\n<sup>한😀글</sup>\r\n뒤',undefined,undefined,undefined,undefined,'sup'],
  ['sub','앞\r\n<sub>한😀글</sub>\r\n뒤',undefined,undefined,undefined,undefined,'sub'],
  ['comment','앞\r\n<!--한😀글-->\r\n뒤'],
  ['inlineMath','앞\r\n$한😀글$\r\n뒤',undefined,undefined,undefined,undefined,'[data-math="inline"]'],
  ['code','앞\r\n`한😀글`\r\n뒤',undefined,undefined,undefined,undefined,'code'],
  ['heading','앞\r\n## 한😀글\r\n뒤',2,undefined,undefined,undefined,'h2'],
  ['quote','앞\r\n> 한😀글\r\n뒤',undefined,undefined,undefined,undefined,'blockquote'],
  ['bullet','앞\r\n- 한😀글\r\n뒤',undefined,undefined,undefined,undefined,'ul li'],
  ['ordered','앞\r\n1. 한😀글\r\n뒤',undefined,undefined,undefined,undefined,'ol li'],
  ['task','앞\r\n- [ ] 한😀글\r\n뒤',undefined,undefined,undefined,undefined,'input[type="checkbox"]'],
  ['toggleTask','앞\r\n- [ ] 한😀글\r\n뒤'],
  ['indent','앞\r\n  한😀글\r\n뒤'],
  ['outdent',auditSource,undefined,'앞\r\n  한😀글\r\n뒤',5,9],
  ['moveLineUp','한😀글\r\n앞\r\n뒤'],
  ['moveLineDown','앞\r\n뒤\r\n한😀글'],
  ['horizontalRule','앞\r\n---\r\n뒤'],
  ['codeBlock','앞\r\n```ts\r\n한😀글\r\n```\r\n뒤','ts',undefined,undefined,undefined,'pre code.language-ts'],
  ['mathBlock','앞\r\n$$\r\n한😀글\r\n$$\r\n뒤',undefined,undefined,undefined,undefined,'[data-math="block"]'],
  ['toc','[TOC]',undefined,'',0,0],
  ['yaml','---\r\n\r\n---\r\n앞\r\n한😀글\r\n뒤'],
  ['alert','앞\r\n> [!NOTE]\r\n> 한😀글\r\n뒤','note',undefined,undefined,undefined,'[data-alert="note"]'],
  ['clearFormat',auditSource,undefined,'앞\r\n**한😀글**\r\n뒤',5,9],
  ['insertParagraphBefore','\r\n\r\n앞\r\n한😀글\r\n뒤'],
  ['insertParagraphAfter','앞\r\n한😀글\r\n뒤\r\n\r\n\r\n\r\n'],
  ['deleteBlock','앞\r\n\r\n\r\n뒤',undefined,'앞\r\n\r\n한😀글\r\n\r\n뒤',5,9],
  ['deleteWord','앞\r\n\r\n뒤',undefined,'앞\r\nhello\r\n뒤',8,8],
  ['link','앞\r\n[한😀글](<https://example.test/a b>)\r\n뒤','https://example.test/a b',undefined,undefined,undefined,'a[href="https://example.test/a%20b"]'],
  ['image','앞\r\n![한😀글](assets/a.png)\r\n뒤','assets/a.png',undefined,undefined,undefined,'img'],
  ['footnote','앞\r\n[^1]\r\n뒤\r\n\r\n[^1]: 한😀글',undefined,undefined,undefined,undefined,'.footnote-ref'],
  ['linkReference','앞\r\n[한😀글][link-1]\r\n뒤\r\n\r\n[link-1]: https://example.test','https://example.test',undefined,undefined,undefined,'a[href="https://example.test"]'],
];
test('mac editing audit: every registered command has a multi-step workflow',()=>{
  assert.deepEqual(editingAuditCases.map(row=>row[0]).sort(),COMMANDS.map(command=>command.type).sort());
});
for(const [type,expected,value,source=auditSource,from=3,to=7,selector] of editingAuditCases)test(`mac editing audit: ${type} survives modes, tabs, undo and redo`,()=>{
  const editor=new DocumentEditor(root()),id='audit-'+type;try{
    editor.open({...snapshot,documentId:id,text:source,lineEnding:'CRLF'});editor.select({from,to});
    editor.command({type,value});assert.equal(editor.text(),expected);const selection=editor.selection();
    for(const mode of ['source','live','reading','source'] as const){editor.mode(mode);assert.equal(editor.text(),expected);assert.deepEqual(editor.selection(),selection);}
    editor.open({...snapshot,documentId:'other',text:'다른😀'});editor.open({...snapshot,documentId:id,text:source,lineEnding:'CRLF'});
    assert.equal(editor.text(),expected);assert.deepEqual(editor.selection(),selection);
    if(selector){const output=rendered(expected);assert.ok(output.querySelector(selector),type+': '+output.innerHTML);}
    if(type==='image')assert.equal(rendered(expected).querySelector('img')!.getAttribute('alt'),'한😀글');
    assert.equal(undo(editor.view),true,type);assert.equal(editor.text(),source,type);assert.deepEqual(editor.selection(),{from,to});
    assert.equal(redo(editor.view),true,type);assert.equal(editor.text(),expected,type);
  }finally{editor.destroy();}
});

test('mac editing audit: table modal composes every row/column operation, edits, alignment and history',()=>{
  const host=root(),editor=new DocumentEditor(host),errors:unknown[]=[];
  const source='앞\r\n\r\n| A | B |\r\n| :--- | ---: |\r\n| 한😀 | x\\|y |\r\n| keep | \\*literal\\* |\r\n\r\n뒤';
  try{
    editor.open({...snapshot,text:source,lineEnding:'CRLF'});editor.select({from:5,to:5});tableDialog(host,editor,()=>editor.text()===source,error=>errors.push(error));
    const click=(label:string)=>{const control=[...host.querySelectorAll<HTMLButtonElement>('.table-dialog button')].find(button=>button.textContent===label);assert.ok(control,label);control.click();};
    const indices=host.querySelectorAll<HTMLInputElement>('.table-tools input[type="number"]'),row=(n:number)=>indices[0].value=String(n),col=(n:number)=>indices[1].value=String(n);
    const cell=host.querySelector<HTMLTextAreaElement>('[data-cell-row="0"][data-cell-col="0"]')!;cell.value='바뀜😀';cell.dispatchEvent(new Event('input'));
    row(2);click('Insert row');row(3);click('Row up');row(2);click('Row down');row(2);click('Remove row');
    col(2);click('Insert column');col(3);click('Column left');col(2);click('Column right');col(2);click('Remove column');
    col(2);const alignment=host.querySelector<HTMLSelectElement>('.table-tools select')!;alignment.value='center';alignment.dispatchEvent(new Event('change'));
    assert.equal(editor.text(),source);click('Apply Table');assert.deepEqual(errors,[]);
    assert.equal(editor.text(),'앞\r\n\r\n| A | B |\r\n| :--- | :---: |\r\n| 바뀜😀 | x\\|y |\r\n| keep | \\*literal\\* |\r\n\r\n뒤');
    const final=editor.text(),table=rendered(final).querySelector('table')!;
    assert.deepEqual([...table.querySelectorAll('tbody td')].map(cell=>cell.textContent),['바뀜😀','x|y','keep','*literal*']);
    assert.equal(table.querySelector('tbody td:nth-child(2)')!.getAttribute('style'),'text-align:center');
    assert.equal(undo(editor.view),true);assert.equal(editor.text(),source);assert.equal(redo(editor.view),true);assert.equal(editor.text(),final);
  }finally{editor.destroy();}
});

test('mac editing audit: table edits preserve the table local newlines in a mixed-ending document',()=>{
  const host=root(),editor=new DocumentEditor(host),errors:unknown[]=[];
  const source='앞\r\n\r\n| A |\n| - |\n| 한😀 |\n\n뒤';
  try{
    editor.open({...snapshot,text:source,lineEnding:'CRLF'});editor.select({from:5,to:5});tableDialog(host,editor,()=>true,error=>errors.push(error));
    host.querySelector<HTMLButtonElement>('[data-action="table-apply"]')!.click();assert.deepEqual(errors,[]);
    assert.equal(editor.text(),'앞\r\n\r\n| A |\n| --- |\n| 한😀 |\n\n뒤');
    assert.equal(undo(editor.view),true);assert.equal(editor.text(),source);
  }finally{editor.destroy();}
});

test('mac editing audit: all heading levels, alert types and preference markers render their intended structures',()=>{
  const editor=new DocumentEditor(root());try{
    let id=0;
    for(let level=1;level<=6;level++){
      editor.open({...snapshot,documentId:String(++id),text:'한😀'});editor.select({from:0,to:3});editor.command({type:'heading',value:level});
      assert.equal(rendered(editor.text()).querySelector('h'+level)!.textContent,'한😀');assert.equal(undo(editor.view),true);assert.equal(editor.text(),'한😀');
    }
    for(const value of ['note','tip','important','warning','caution']){
      editor.open({...snapshot,documentId:String(++id),text:'한😀'});editor.select({from:0,to:3});editor.command({type:'alert',value});
      assert.equal(rendered(editor.text()).querySelector('[data-alert]')!.getAttribute('data-alert'),value);assert.equal(undo(editor.view),true);assert.equal(editor.text(),'한😀');
    }
    editor.configure({boldMarker:'__',italicMarker:'_',bulletMarker:'+'});
    for(const [type,expected] of [['bold','__한😀__'],['italic','_한😀_'],['bullet','+ 한😀']]){
      editor.open({...snapshot,documentId:String(++id),text:'한😀'});editor.select({from:0,to:3});editor.mode('reading');editor.command({type});
      assert.equal(editor.text(),expected);assert.equal(editor.view.dom.dataset.mode,'live');assert.equal(undo(editor.view),true);assert.equal(editor.text(),'한😀');
    }
  }finally{editor.destroy();}
});

test('mac editing audit: heading, reference, footnote and YAML compose in one CRLF editing workflow',()=>{
  const editor=new DocumentEditor(root());try{
    const initial='제목\r\n\r\n참조 설명과 각주😀\r\n';editor.open({...snapshot,text:initial,lineEnding:'CRLF'});
    editor.select({from:0,to:2});editor.command({type:'heading',value:1});
    const ref=editor.text().indexOf('참조');editor.select({from:ref,to:ref+2});editor.command({type:'linkReference',value:'https://example.test'});
    const note=editor.text().indexOf('각주');editor.select({from:note,to:note+4});editor.command({type:'footnote'});editor.command({type:'yaml'});
    editor.view.dispatch({...editor.view.state.replaceSelection('title: 감사'),userEvent:'input.type'});
    assert.equal(editor.text(),'---\r\ntitle: 감사\r\n---\r\n# 제목\r\n\r\n[참조][link-1] 설명과 [^1]\r\n\r\n[link-1]: https://example.test\r\n\r\n[^1]: 각주😀\r\n');
    const output=rendered(editor.text());assert.equal(output.querySelector('h1')!.textContent,'제목');assert.equal(output.querySelector('a[href="https://example.test"]')!.textContent,'참조');assert.match(output.querySelector('.footnote-item')!.textContent!,/각주😀/);assert.doesNotMatch(output.textContent!,/title: 감사/);
    editor.mode('reading');editor.mode('source');for(let i=0;i<5;i++)assert.equal(undo(editor.view),true);assert.equal(editor.text(),initial);
  }finally{editor.destroy();}
});
