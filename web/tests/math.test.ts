import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { pathToFileURL } from 'node:url';
import * as previews from '../render/previews.ts';
import { renderMarkdown } from '../render/markdown.ts';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { livePreview } from '../client/live.ts';
import { sourceField, sourceToCM, normalized } from '../client/editor.ts';

const requests: string[] = [];
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: pathToFileURL(new URL('../dist/index.html', import.meta.url).pathname).href,
  runScripts: 'dangerously', resources: { interceptors: [requestInterceptor(request => {
    requests.push(request.url);
    if (!request.url.startsWith('file:')) throw new Error(`Unexpected network request: ${request.url}`);
  })] }, virtualConsole: new VirtualConsole(),
});
dom.window.matchMedia = (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) as any;
globalThis.window = dom.window as any;
globalThis.document = dom.window.document;

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { dom.window.close(); reject(new Error('Local MathJax exceeded 8s deadline')); }, 8000);
    })]);
  } finally { clearTimeout(timer!); }
}
function page(source: string) {
  const element = document.createElement('article');
  element.innerHTML = renderMarkdown(source);
  return element; // Deliberately detached: same contract as HTML export.
}
function tags(element: HTMLElement) {
  return [...element.querySelectorAll('[data-math]')].map(node =>
    [...node.querySelectorAll('svg[data-labels] use[data-c]')]
      .map(glyph => String.fromCodePoint(parseInt(glyph.getAttribute('data-c')!, 16))).join(''));
}
test('detached export formulas have finite SVG dimensions and viewBox geometry',async()=>{
  const element=page('$$a^2+b^2=c^2$$\n\n$\\frac{1}{2}$');
  await bounded(previews.typesetPreviews(element));
  for(const svg of element.querySelectorAll('svg')){
    assert.doesNotMatch(svg.outerHTML,/NaN|Infinity/);
    const box=svg.getAttribute('viewBox')!.split(/\s+/).map(Number);
    assert.equal(box.length,4);assert.ok(box.every(Number.isFinite));assert.ok(box[2]>0&&box[3]>0);
  }
  assert.equal(element.querySelectorAll('svg').length,2);
});

test('local classic MathJax gives repeated formulas distinct stable literal tags', async () => {
  const source = '$$x=1$$\n\n$$x=1$$\n';
  for (let pass = 0; pass < 2; pass++) {
    const element = page(source);
    await bounded(previews.typesetPreviews(element, { numbering: 'all' }));
    assert.equal(element.querySelectorAll('mjx-container').length, 2);
    assert.deepEqual(tags(element), ['(1)', '(2)']);
  }
  assert.equal((dom.window as any).MathJax.version, '3.2.2');
});

test('explicit numbering changes rebuild the engine in both directions', async () => {
  for (const [numbering, expected] of [['none', ['']], ['all', ['(1)']], ['ams', ['']]] as const) {
    const element = page('$$y=2$$');
    await bounded(previews.typesetPreviews(element, { numbering }));
    assert.deepEqual(tags(element), expected);
  }
});

test('labels resolve forward references and never leak to another document', async () => {
  const first = page('$\\eqref{later}$\n\n$$\\begin{equation}x=1\\label{later}\\end{equation}$$');
  await bounded(previews.typesetPreviews(first, { numbering: 'ams', documentId: 'a' }));
  assert.equal(decodeURIComponent(first.querySelector('a')?.getAttribute('href') ?? ''), '#mjx-eqn:later');
  assert.doesNotMatch(first.innerHTML, /TEX-N-3F/); // Literal '?' glyph means unresolved reference.
  const second = page('$\\eqref{later}$');
  await bounded(previews.typesetPreviews(second, { numbering: 'ams', documentId: 'b' }));
  assert.match(second.innerHTML, /TEX-N-3F/);
  assert.notEqual(decodeURIComponent(second.querySelector('a')?.getAttribute('href') ?? ''), '#mjx-eqn:later');
});

test('malformed TeX is visibly reported with its source', async () => {
  const element = page('$$\\frac{1}{$$');
  await bounded(previews.typesetPreviews(element));
  const node = element.querySelector('[data-math]')!;
  assert.equal(node.classList.contains('preview-error'), true);
  assert.match(node.textContent!, /\\frac\{1\}\{/);
});

test('full CRLF source and widget offset select the second repeated equation and forward label', async () => {
  const source = '# 한글\r\n\r\n$$x=1$$\r\n\r\n$$x=1$$\r\n\r\n$\\eqref{end}$\r\n\r\n$$y=2\\label{end}$$';
  const offset = source.lastIndexOf('$$x=1$$');
  const element = page('$$x=1$$'); element.dataset.sourceOffset = String(offset);
  await bounded(previews.typesetPreviews(element, { numbering: 'all', documentId: 'crlf', documentSource: source }));
  assert.deepEqual(tags(element), ['(2)']);
  const reference = page('$\\eqref{end}$');
  await bounded(previews.typesetPreviews(reference, { numbering: 'all', documentId: 'crlf', documentSource: source, sourceOffset: source.indexOf('$\\eqref') }));
  assert.doesNotMatch(reference.innerHTML, /TEX-N-3F/);
  assert.equal(decodeURIComponent(reference.querySelector('a')?.getAttribute('href') ?? ''), '#mjx-eqn:end');
  const edited = '$$z=0$$\r\n\r\n' + source;
  await bounded(previews.typesetPreviews(element, { numbering: 'all', documentId: 'crlf', documentSource: edited, sourceOffset: edited.lastIndexOf('$$x=1$$') }));
  assert.deepEqual(tags(element), ['(3)']);
});

test('copy conversion returns actual SVG and MathML with document numbering and errors', async () => {
  const source = '$$x=1$$\n\n$$x=1$$';
  const options = { numbering: 'all' as const, documentSource: source, sourceOffset: source.indexOf('$$x', 2) };
  const mml = await bounded(previews.convertMath('x=1', 'mathml', options));
  assert.match(mml, /<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(mml, /<mtext>\(2\)<\/mtext>/);
  const svg = await bounded(previews.convertMath('x=1', 'svg', options));
  assert.match(svg, /^<svg /); assert.doesNotMatch(svg, /<mjx-container/);
  assert.match(svg, /id="mjx-eqn:2"/);
  await assert.rejects(bounded(previews.convertMath('\\frac{1}{', 'mathml')), /수식|brace|argument/i);
});

test('physics changes on and off and never loads remote resources or SRE', async () => {
  const off = page('$$\\qty(x)$$');
  await bounded(previews.typesetPreviews(off, { physics: false }));
  assert.match(await bounded(previews.convertMath('\\qty(x)', 'mathml', { physics: false })), /<mtext mathcolor="red">\\qty<\/mtext>/);
  const on = page('$$\\qty(x)$$');
  await bounded(previews.typesetPreviews(on, { physics: true }));
  assert.equal(on.querySelector('.preview-error'), null);
  assert.equal(on.querySelectorAll('mjx-container').length, 1);
  assert.doesNotMatch(await bounded(previews.convertMath('\\qty(x)', 'mathml', { physics: true })), /mathcolor="red"|\\qty/);
  previews.clearPreviewCache();
  const again = page('$$\\qty(x)$$');
  await bounded(previews.typesetPreviews(again, { physics: false }));
  assert.match(await bounded(previews.convertMath('\\qty(x)', 'mathml', { physics: false })), /<mtext mathcolor="red">\\qty<\/mtext>/);
  const resources = [...requests, ...[...document.scripts].map(script => script.src)];
  assert.ok(resources.some(url => url.endsWith('/vendor/mathjax/tex-svg-full.js')));
  assert.ok(resources.every(url => url.startsWith('file:')));
  assert.ok(resources.every(url => !/\/sre\/|speech-rule-engine/.test(url)));
});

test('overlapping renders reject stale output and serial work isolates document macros', async () => {
  const element = page('$$a=1$$');
  const node = element.querySelector<HTMLElement>('[data-math]')!;
  const old = previews.typesetPreviews(element, { numbering: 'all' });
  node.dataset.source = 'b=2';
  const latest = previews.typesetPreviews(element, { numbering: 'none' });
  await bounded(Promise.all([old, latest]));
  assert.deepEqual(tags(element), ['']); assert.match(node.innerHTML, /TEX-I-1D44F/); // b
  assert.doesNotMatch(node.innerHTML, /TEX-I-1D44E/); // a
  const definitions = page('$$\\newcommand{\\onlyhere}{42}\\onlyhere$$');
  const other = page('$$\\onlyhere$$');
  await bounded(Promise.all([
    previews.typesetPreviews(definitions, { documentId: 'macros-a' }),
    previews.typesetPreviews(other, { documentId: 'macros-b' }),
  ]));
  assert.equal(definitions.querySelector('.preview-error'), null);
  assert.match(await bounded(previews.convertMath('\\onlyhere', 'mathml', { documentId: 'macros-b' })), /<mtext mathcolor="red">\\onlyhere<\/mtext>/);
  assert.doesNotMatch(other.innerHTML, /data-c="34"|data-c="32"/); // Must not expand to 42.
});

test('an unfound malformed expression does not misalign the next valid equation', async () => {
  const element = page('$$\\frac{1}{$$\n\n$$x=1$$');
  await bounded(previews.typesetPreviews(element, { numbering: 'all' }));
  assert.ok(element.children[0].classList.contains('preview-error'));
  assert.equal(element.children[1].classList.contains('preview-error'), false);
  assert.deepEqual(tags(element), ['', '(1)']);
});

test('Live widget metadata uses canonical source offsets across CRLF and Unicode', () => {
  const source = '# 시작😀\r\n\r\n앞 문장\r\n\r\n$$x=1$$\r\n';
  const state = EditorState.create({ doc: normalized(source), extensions: [
    sourceField.init(() => ({ text: source, eol: '\r\n' })), livePreview(),
  ] });
  const decorations = state.facet(EditorView.decorations)[0];
  const set = decorations as any;
  const widgets: HTMLElement[] = [];
  set.between(0, state.doc.length, (_from: number, _to: number, decoration: any) => {
    if (decoration.spec.widget) widgets.push(decoration.spec.widget.toDOM({ state }));
  });
  const widget = widgets.find(element => element.querySelector('[data-math]'))!;
  assert.ok(widget);
  const offset = source.indexOf('$$x');
  assert.notEqual(offset, sourceToCM(source, offset));
  assert.equal(widget.dataset.sourceOffset, String(offset));
});

test('ordinary Live math keeps rendering before the parent supplies full source context', async () => {
  const element = page('$$x=1$$'); element.dataset.sourceOffset = '120';
  await bounded(previews.typesetPreviews(element));
  assert.equal(element.querySelector('.preview-error'), null);
  assert.equal(element.querySelectorAll('mjx-container').length, 1);
});

test('rendered math does not retain executable link protocols',async()=>{
  const svg=await bounded(previews.convertMath('\\href{javascript:alert(1)}{x}','svg',{display:false}));
  assert.doesNotMatch(svg,/javascript:/i);
  const element=page('$\\href{javascript:alert(1)}{x}$');await bounded(previews.typesetPreviews(element));
  for(const node of element.querySelectorAll('a,use'))assert.doesNotMatch(node.getAttribute('href')??node.getAttribute('xlink:href')??'',/^\s*javascript:/i);
});
test.after(() => { dom.window.close(); });
