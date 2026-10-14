import { StateField, StateEffect, RangeSetBuilder, Transaction } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { markdownBlocks } from '../render/markdown.ts';
import { sourceLines, openingFence, closesFence } from '../core/source.ts';
import { sourceField, sourceToCM, cmToSource } from './editor.ts';
interface PreviewOptions { typeset?: (element: HTMLElement) => Promise<void>; openExternal?: (url: string) => void }
const viewportEffect = StateEffect.define<{ from: number; to: number }>();
const compositionEffect = StateEffect.define<boolean>();
class MarkdownWidget extends WidgetType {
  html: string; from: number; to:number; options: PreviewOptions;
  constructor(html: string, from: number,to:number, options: PreviewOptions) { super(); this.html = html; this.from = from;this.to=to; this.options = options; }
  eq(other: MarkdownWidget): boolean { return other.html === this.html && other.from === this.from&&other.to===this.to; }
  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('div'); element.className = 'live-block markdown-body'; element.innerHTML = this.html; element.tabIndex = 0; element.setAttribute('aria-label', 'Edit this Markdown block');
    element.dataset.sourceOffset = String(cmToSource(view.state.field(sourceField).text, this.from));
    const edit = () => { view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true }); view.focus(); };
    element.addEventListener('click', event => {
      const target = event.target as Element;
      if (target.matches('input.task-list-item-checkbox[data-mori-task="true"]')) {
        event.preventDefault(); event.stopPropagation();
        if(view.state.readOnly)return;
        const source = view.state.field(sourceField).text, start = cmToSource(source, this.from);
        const index = [...element.querySelectorAll('input.task-list-item-checkbox[data-mori-task="true"]')].indexOf(target);
        const end=cmToSource(source,this.to);
        const matches = [...source.slice(start,end).matchAll(/^([ \t]*(?:>[ \t]*)*(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\])/gm)];
        const match = matches[index];
        if (match) {
          const position = sourceToCM(source, start + match.index! + match[1].length);
          view.dispatch({ changes: { from: position, to: position + 1, insert: match[2] === ' ' ? 'x' : ' ' }, annotations: [Transaction.userEvent.of('input.task'), isolateHistory.of('full')] });
          view.focus();
        }
        return;
      }
      const link = target.closest('a'); if (link) { event.preventDefault(); this.options.openExternal?.(link.getAttribute('href') ?? ''); } else edit();
    });
    element.addEventListener('keydown', event => { if (event.target === element && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); edit(); } });
    if (this.options.typeset && element.querySelector('[data-math],[data-diagram],img')) void this.options.typeset(element).catch(error => { if (element.isConnected) { const message = document.createElement('p'); message.className = 'preview-error'; message.textContent = `Preview: ${error.message}`; element.append(message); } });
    return element;
  }
  ignoreEvent(): boolean { return true; }
}
interface PreviewState { decorations: DecorationSet; from: number; to: number; composing: boolean }
function decorate(state: EditorState, viewport: { from: number; to: number }, options: PreviewOptions): DecorationSet {
  const source = state.field(sourceField).text, lines = sourceLines(source);
  const sourceFrom = cmToSource(source, Math.max(0, viewport.from - 1200)), sourceTo = cmToSource(source, Math.min(state.doc.length, viewport.to + 1200));
  let first = lines.findIndex(line => line.end >= sourceFrom); if (first < 0) first = 0;
  let last = lines.findIndex(line => line.end >= sourceTo); if (last < 0) last = lines.length - 1;
  while (first > 0 && lines[first - 1].text.trim()) first--;
  while (last + 1 < lines.length && lines[last].text.trim()) last++;
  // Extend across fence boundaries, but leave exceptionally long blocks as source.
  let fence: ReturnType<typeof openingFence> = null, fenceStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!fence) { fence = openingFence(lines[i].text); if (fence) fenceStart = i; }
    else if (closesFence(lines[i].text, fence)) { if (fenceStart <= first && i >= first) first = fenceStart; if (fenceStart <= last && i >= last) last = i; fence = null; }
  }
  const start = lines[first].from, end = lines[last].end;
  if (end - start > 24_000) return Decoration.none;
  const decorations: { from: number; to: number; decoration: Decoration }[] = [];
  const selections = state.selection.ranges;
  const blocks = markdownBlocks(source.slice(start, end));
  for (const block of blocks) {
    const from = sourceToCM(source, start + block.from), rawTo = sourceToCM(source, start + block.to);
    const to = state.doc.lineAt(Math.max(from, rawTo - 1)).to;
    if (to <= from || selections.some(selection => selection.from <= to && selection.to >= from)) continue;
    decorations.push({ from, to, decoration: Decoration.replace({ block: true, widget: new MarkdownWidget(block.html, from,to, options) }) });
  }
  for (const line of lines.slice(first, last + 1)) {
    const from = sourceToCM(source, line.from);
    if (decorations.some(item => from >= item.from && from < item.to)) continue;
    const heading = /^ {0,3}(#{1,6})\s/.exec(line.text);
    if (heading) decorations.push({ from, to: from, decoration: Decoration.line({ class: `live-heading live-heading-${heading[1].length}` }) });
  }
  decorations.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of decorations) builder.add(item.from, item.to, item.decoration);
  return builder.finish();
}
export function livePreview(options: PreviewOptions = {}) {
  const field = StateField.define<PreviewState>({
    create(state) { const viewport = { from: 0, to: Math.min(state.doc.length, 1600) }; return { ...viewport, composing: false, decorations: decorate(state, viewport, options) }; },
    update(value, transaction) {
      let next = { ...value, decorations: value.decorations.map(transaction.changes) }, refresh = transaction.docChanged || !!transaction.selection;
      for (const effect of transaction.effects) {
        if (effect.is(viewportEffect)) { next = { ...next, ...effect.value }; refresh = true; }
        if (effect.is(compositionEffect)) { next.composing = effect.value; refresh = !effect.value; }
      }
      if (refresh && !next.composing) next.decorations = decorate(transaction.state, next, options);
      return next;
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  });
  return [field, ViewPlugin.fromClass(class {
    view: EditorView; frame = 0; from = -1; to = -1;
    constructor(view: EditorView) { this.view = view; this.schedule(); }
    update(update: any) { if (update.viewportChanged || update.docChanged) this.schedule(); }
    schedule() {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = 0; const ranges = this.view.visibleRanges; const from = ranges[0]?.from ?? 0, to = ranges.at(-1)?.to ?? 0; if (from === this.from && to === this.to) return; this.from = from; this.to = to; this.view.dispatch({ effects: viewportEffect.of({ from, to }), annotations: [] }); });
    }
    destroy() { if (this.frame) cancelAnimationFrame(this.frame); }
  }), EditorView.domEventHandlers({ compositionstart(_event, view) { view.dispatch({ effects: compositionEffect.of(true) }); return false; }, compositionend(_event, view) { queueMicrotask(() => { if (view.dom.isConnected) view.dispatch({ effects: compositionEffect.of(false) }); }); return false; } })];
}
