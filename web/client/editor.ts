import { Compartment, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, invertedEffects, isolateHistory, indentSelection } from '@codemirror/commands';
import { markdown,commonmarkLanguage,markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import {javascript} from '@codemirror/lang-javascript';
import {python} from '@codemirror/lang-python';
import {json} from '@codemirror/lang-json';
import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import { closeBrackets, closeBracketsKeymap,autocompletion } from '@codemirror/autocomplete';
import {emojiCompletionSource} from './completion.ts';
import { applyCommand } from '../core/commands.ts';
import type { EditorCommand, Selection,CommandStyle } from '../core/commands.ts';
import type { NativeSnapshot } from './bridge.ts';
import type { DocumentViewState } from '../core/session.ts';
import { livePreview } from './live.ts';
import { proofreading } from './proofreading.ts';
import type { ProofreadingOptions } from './proofreading.ts';
export interface SourceState { text: string; eol: string }
export const sourceEffect = StateEffect.define<SourceState>();
export const normalized = (text: string) => text.replace(/\r\n|\r/g, '\n');
const codeLanguages={javascript:javascript().language,typescript:javascript({typescript:true}).language,python:python().language,json:json().language,css:css().language,html:html().language};
function codeLanguage(info:string){const name=info.trim().split(/\s+/)[0].toLowerCase(),alias:Record<string,string>={js:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',py:'python',htm:'html'};return codeLanguages[(alias[name]??name) as keyof typeof codeLanguages]??null;}
export function sourceToCM(text: string, position: number): number { return normalized(text.slice(0, position)).length; }
export function cmToSource(text: string, position: number): number {
  let source = 0, offset = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const length = match.index! - source;
    if (position <= offset + length) return source + position - offset;
    offset += length + 1; source = match.index! + match[0].length;
  }
  return Math.min(text.length, source + position - offset);
}
export const sourceField = StateField.define<SourceState>({
  create: () => ({ text: '', eol: '\n' }),
  update(value, transaction) {
    if (transaction.docChanged) {
      const chunks: string[] = []; let cursor = 0;
      transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
        const start = cmToSource(value.text, from), end = cmToSource(value.text, to);
        chunks.push(value.text.slice(cursor, start), inserted.toString().replace(/\n/g, value.eol)); cursor = end;
      });
      chunks.push(value.text.slice(cursor)); value = { ...value, text: chunks.join('') };
    }
    for (const effect of transaction.effects) if (effect.is(sourceEffect)) value = effect.value;
    return value;
  },
});
export interface EditorOptions { onChange?: (id: string, text: string) => void; onSelection?: () => void; typeset?: (element: HTMLElement) => Promise<void>; openExternal?: (url: string) => void; onShortcut?: (action: string) => void; onPaste?: (event:ClipboardEvent)=>boolean; onDrop?: (event:DragEvent)=>boolean; proofreading?:ProofreadingOptions }
export interface EditorConfiguration extends CommandStyle { wrap?:boolean;lineNumbers?:boolean;fontSize?:number;width?:number;tabSize?:number;spellcheck?:boolean;pairing?:boolean;emojiCompletion?:boolean;strictSyntax?:boolean }
export class DocumentEditor {
  private configuration = { wrap: true, lineNumbers: false,tabSize:4,spellcheck:true,pairing:true,emojiCompletion:true,strictSyntax:false,boldMarker:'**' as '**'|'__',italicMarker:'*' as '*'|'_',bulletMarker:'-' as '-'|'+'|'*' };
  private input = new Compartment();
  private locked=false;
  view: EditorView; private options: EditorOptions; private current = ''; private sessions = new Map<string, { state: EditorState; scroll: number }>(); private appearance = new Compartment(); private preview = new Compartment(); private editable = new Compartment(); private wrap = new Compartment(); private numbers = new Compartment(); private currentMode: 'source' | 'live' | 'reading' = 'live'; private destroyed = false;
  constructor(parent: HTMLElement, options: EditorOptions = {}) { this.options = options; this.view = new EditorView({ parent, state: this.state('', '\n') }); }
  private state(text: string, eol: string): EditorState {
    const shortcut = (type: string) => () => { this.command({ type }); return true; };
    return EditorState.create({ doc: normalized(text), extensions: [
      sourceField.init(() => ({ text, eol })), syntaxHighlighting(defaultHighlightStyle), bracketMatching(),this.input.of(this.inputExtensions()), history(), drawSelection(), highlightActiveLine(),
      EditorState.transactionFilter.of(transaction=>this.locked&&transaction.docChanged?[]:transaction),
      ...(this.options.proofreading?[proofreading({...this.options.proofreading,getText:state=>state.field(sourceField).text})]:[]),
      invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(sourceEffect)) ? [sourceEffect.of(transaction.startState.field(sourceField))] : []),
      keymap.of([{ key: 'Mod-b', run: shortcut('bold') }, { key: 'Mod-i', run: shortcut('italic') }, { key: 'Mod-u', run: shortcut('underline') }, ...['s', 'o', 'n', 'f', 'p'].map(key => ({ key: `Mod-${key}`, run: () => { this.options.onShortcut?.(({ s: 'save', o: 'open', n: 'new', f: 'find', p: 'quick-open' } as any)[key]); return true; } })), ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
      this.preview.of(this.previewExtension()), this.editable.of([EditorView.editable.of(this.currentMode !== 'reading'), EditorState.readOnly.of(this.currentMode === 'reading')]),
      this.wrap.of(this.configuration.wrap ? EditorView.lineWrapping : []), this.numbers.of(this.configuration.lineNumbers ? lineNumbers() : []), this.appearance.of(this.languageExtension()),
      EditorView.domEventHandlers({paste:event=>this.options.onPaste?.(event)??false,drop:event=>this.options.onDrop?.(event)??false}),
      EditorView.updateListener.of(update => {
        const before = update.startState.field(sourceField).text, after = update.state.field(sourceField).text;
        if (before !== after && this.current) this.options.onChange?.(this.current, after);
        if (update.selectionSet || update.docChanged) this.options.onSelection?.();
      }),
    ] });
  }
  private inputExtensions(){return [EditorState.tabSize.of(this.configuration.tabSize),indentUnit.of(' '.repeat(this.configuration.tabSize)),EditorView.contentAttributes.of({'aria-label':'Markdown document',spellcheck:String(this.configuration.spellcheck)}),...(this.configuration.pairing?[closeBrackets()]:[]),...(this.configuration.emojiCompletion?[autocompletion(),EditorState.languageData.of(()=>[{autocomplete:emojiCompletionSource}])]:[])];}
  private previewExtension() { return this.currentMode === 'live' ? livePreview({ typeset: this.options.typeset, openExternal: this.options.openExternal }) : []; }
  private languageExtension(){return markdown({base:this.configuration.strictSyntax?commonmarkLanguage:markdownLanguage,codeLanguages:codeLanguage});}
  open(snapshot: NativeSnapshot): void {
    if (snapshot.documentId === this.current) return;
    if (this.current) this.sessions.set(this.current, { state: this.view.state, scroll: this.view.scrollDOM.scrollTop });
    this.current = snapshot.documentId;
    const session = this.sessions.get(this.current);
    this.view.setState(session?.state ?? this.state(snapshot.text, snapshot.lineEnding === 'CRLF' ? '\r\n' : '\n'));
    this.mode(this.currentMode); this.configure(this.configuration); this.view.scrollDOM.scrollTop = session?.scroll ?? 0;
  }
  text(): string { return this.view.state.field(sourceField).text; }
  close(id:string):void{this.sessions.delete(id);if(this.current===id)this.current='';}
  clear():void {this.current='';this.view.setState(this.state('','\n'));this.mode(this.currentMode);}
  captureView(id:string):DocumentViewState|undefined{
    const session=id===this.current?{state:this.view.state,scroll:this.view.scrollDOM.scrollTop}:this.sessions.get(id);if(!session)return undefined;
    const text=session.state.field(sourceField).text,selection=session.state.selection.main;return {anchor:cmToSource(text,selection.anchor),head:cmToSource(text,selection.head),scroll:session.scroll};
  }
  restoreView(position:DocumentViewState):void{
    const text=this.text(),safe=(value:number)=>{let offset=Math.max(0,Math.min(text.length,Math.floor(value)));const before=text.charCodeAt(offset-1),after=text.charCodeAt(offset);if((before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff)||(text[offset-1]==='\r'&&text[offset]==='\n'))offset--;return sourceToCM(text,offset);};
    this.view.dispatch({selection:{anchor:safe(position.anchor),head:safe(position.head)}});this.view.scrollDOM.scrollTop=position.scroll;
  }
  autoIndent(all=false):void{
    if(this.currentMode==='reading')this.mode('source');const original=this.view.state.selection;
    if(all)this.view.dispatch({selection:{anchor:0,head:this.view.state.doc.length}});
    indentSelection({state:this.view.state,dispatch:transaction=>{
      const selection=all?original.map(transaction.changes):transaction.newSelection;
      this.view.dispatch({changes:transaction.changes,selection,annotations:[Transaction.userEvent.of('input.indent'),isolateHistory.of('full')]});
    }});
    if(all && this.view.state.selection.main.from===0 && this.view.state.selection.main.to===this.view.state.doc.length)this.view.dispatch({selection:original});
  }
  selection(): Selection { const selection = this.view.state.selection.main, text = this.text(); return { from: cmToSource(text, selection.from), to: cmToSource(text, selection.to) }; }
  lineEnding():'LF'|'CRLF' {return this.view.state.field(sourceField).eol==='\r\n'?'CRLF':'LF';}
  select(selection: Selection): void { const text = this.text(); this.view.dispatch({ selection: { anchor: sourceToCM(text, selection.from), head: sourceToCM(text, selection.to) }, scrollIntoView: true }); this.view.focus(); }
  command(command: EditorCommand): void { if (this.currentMode === 'reading') this.mode('live'); const result = applyCommand(this.text(), this.selection(), command,this.configuration); this.replace(result.text, result.selection); }
  replace(text: string, selection: Selection = this.selection(), lineEnding?:string): void {
    if(this.locked)throw new Error('This document is closing.');
    const old = this.view.state.doc.toString(), next = normalized(text); let from = 0, endOld = old.length, endNew = next.length;
    while (from < endOld && from < endNew && old[from] === next[from]) from++;
    while (endOld > from && endNew > from && old[endOld - 1] === next[endNew - 1]) { endOld--; endNew--; }
    const current = this.view.state.field(sourceField), eol=lineEnding==='CRLF'?'\r\n':lineEnding==='LF'?'\n':current.eol;
    this.view.dispatch({ changes: { from, to: endOld, insert: next.slice(from, endNew) }, effects: sourceEffect.of({ text,eol }), selection: { anchor: sourceToCM(text, Math.min(text.length, selection.from)), head: sourceToCM(text, Math.min(text.length, selection.to)) }, annotations: [Transaction.userEvent.of('input.command'), isolateHistory.of('full')], scrollIntoView: true });
  }
  mode(mode: 'source' | 'live' | 'reading'): void { this.currentMode = mode; this.view.dispatch({ effects: [this.preview.reconfigure(this.previewExtension()), this.editable.reconfigure([EditorView.editable.of(mode !== 'reading'&&!this.locked), EditorState.readOnly.of(mode === 'reading'||this.locked)]),this.numbers.reconfigure(mode==='source'&&this.configuration.lineNumbers?lineNumbers():[])] }); this.view.dom.dataset.mode = mode; }
  setLocked(locked:boolean):void {this.locked=locked;this.mode(this.currentMode);}
  setLineEnding(ending: 'LF' | 'CRLF'): void {
    if(this.locked)throw new Error('This document is closing.');
    const eol = ending === 'CRLF' ? '\r\n' : '\n', text = normalized(this.text()).replace(/\n/g, eol), selection = this.view.state.selection.main;
    this.view.dispatch({ effects: sourceEffect.of({ text, eol }), selection, annotations: [Transaction.userEvent.of('input.line-ending'), isolateHistory.of('full')] });
  }
  configure(options: EditorConfiguration): void {
    const effects: StateEffect<unknown>[] = [];
    if (options.wrap !== undefined) { this.configuration.wrap = options.wrap; effects.push(this.wrap.reconfigure(options.wrap ? EditorView.lineWrapping : [])); }
    if (options.lineNumbers !== undefined) { this.configuration.lineNumbers = options.lineNumbers; effects.push(this.numbers.reconfigure(options.lineNumbers&&this.currentMode==='source' ? lineNumbers() : [])); }
    if(options.tabSize!==undefined){if(!Number.isInteger(options.tabSize)||options.tabSize<1||options.tabSize>16)throw new Error('Tab size must be between 1 and 16.');this.configuration.tabSize=options.tabSize;}
    if(options.spellcheck!==undefined)this.configuration.spellcheck=options.spellcheck;
    if(options.pairing!==undefined)this.configuration.pairing=options.pairing;
    if(options.emojiCompletion!==undefined)this.configuration.emojiCompletion=options.emojiCompletion;
    if(options.strictSyntax!==undefined){this.configuration.strictSyntax=options.strictSyntax;effects.push(this.appearance.reconfigure(this.languageExtension()));}
    if(options.boldMarker!==undefined)this.configuration.boldMarker=options.boldMarker;
    if(options.italicMarker!==undefined)this.configuration.italicMarker=options.italicMarker;
    if(options.bulletMarker!==undefined)this.configuration.bulletMarker=options.bulletMarker;
    effects.push(this.input.reconfigure(this.inputExtensions()));
    this.view.dispatch({ effects });
  }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.view.destroy(); this.sessions.clear(); } }
}
