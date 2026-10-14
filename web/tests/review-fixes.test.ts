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
