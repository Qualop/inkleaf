import { UILocalizer } from './i18n.ts';
import { shell } from './shell.ts';
import { builtInThemes, normalizeUserThemes, resolveDocumentTheme, scopeThemeCSS, themeExportCSS } from './themes.ts';
import type { DocumentTheme } from './themes.ts';
import { organizeSettings } from './settings-layout.ts';
import { annotatePreview, normalizeProofreadingResult, refreshProofreading, showProofreadingSuggestions } from './proofreading.ts';
import type { ProofreadingIssue, ProofreadingResult } from './proofreading.ts';
import { NativeClient, NativeError, normalizeSnapshot } from './bridge.ts';
import type { NativeSnapshot } from './bridge.ts';
import { DocumentEditor } from './editor.ts';
import { OutlineNavigator } from './outline.ts';
import {openImageDialog} from './image-dialog.ts';
import { COMMANDS } from '../core/commands.ts';
import type { EditorCommand } from '../core/commands.ts';
import { findMatches, replaceMatches } from '../core/search.ts';
import type { SearchMatch, SearchOptions } from '../core/search.ts';
import { getStatistics, getOutline } from '../core/statistics.ts';
import { sourceLines, lineAt } from '../core/source.ts';
import { stripFormat } from '../core/format.ts';
import { htmlToMarkdown } from '../core/clipboard.ts';
import { renderMarkdown, markdownBlocks, exportHTML, exportFilename, sanitizeHTML, configureMarkdown } from '../render/markdown.ts';
import { typesetPreviews, clearPreviewCache, convertMath } from '../render/previews.ts';
import { tableDialog } from './table.ts';
import { button, field, input, select, modal, promptValue } from './dialog.ts';
import { discoverImages, resolveImageReferences, localImagePlan, localImageURL, localImagePath, imageURLForPath, replaceImageURLs, uploadImages, parseUploaderArguments, convertImageSyntax, relativeImageURLs, planImageFileOperation, manageImageFiles } from '../core/images.ts';
import { normalizeSession, recordRecent, moveSessionPath } from '../core/session.ts';
import type { ImageFileOperation } from '../core/images.ts';
import type { SavedSession } from '../core/session.ts';
import { undo, redo } from '@codemirror/commands';
import { parser as markdownParser } from '@lezer/markdown';
import { EditorView } from '@codemirror/view';

interface MutationOrigin { documentId: string; path:string|null; revision: number; source: string; selection: {from:number;to:number} }
interface DocumentRecord extends NativeSnapshot { savedRevision: number; saving: number; savedContent?:{text:string;encoding:string} }
interface ProductivityPreferences {autoSave:boolean;watchFiles:boolean;strictSyntax:boolean;emojiCompletion:boolean; boldMarker:'**'|'__';italicMarker:'*'|'_';bulletMarker:'-'|'+'|'*'; autoLinks:boolean;smartPunctuation:boolean;renderHTML:boolean; defaultCodeLanguage:string;lastCodeLanguage:string;rememberCodeLanguage:boolean; fileSort:'name'|'modified'|'size';pinnedFolders:string[]; customCSS:string; tabSize:number; pairing:boolean; spellcheck:boolean; richPaste:boolean }
interface Preferences extends ProductivityPreferences { appIcon:'ink'|'leaf'; language:'en'|'ko'; restoreSession:boolean; restoreUnsaved:boolean; grammarCheck:boolean; spellLanguage:string; personalDictionary:string[]; documentTheme:string; documentOverrides:Record<string,DocumentOverrides>; theme: string; fontSize: number; fontFamily: string; documentWidth: number; lineHeight: number; wrap: boolean; lineNumbers: boolean; focus: boolean; typewriter: boolean; mode: 'source' | 'live' | 'reading'; pandocPath: string; imageUploaderPath:string; imageUploaderArguments:string; mathNumbering:'none'|'ams'|'all'; mathPhysics:boolean; session:SavedSession; recentFiles:string[]; recentFolders:string[]; exportPresets: Record<string, any> }
const documentPreferenceKeys=['documentTheme','grammarCheck','spellLanguage','fontSize','fontFamily','documentWidth','lineHeight','wrap','lineNumbers','focus','typewriter','mode','tabSize','pairing','spellcheck','emojiCompletion','strictSyntax','boldMarker','italicMarker','bulletMarker','defaultCodeLanguage','lastCodeLanguage','rememberCodeLanguage','mathNumbering','mathPhysics','autoLinks','smartPunctuation','renderHTML','customCSS'] as const;
type DocumentPreferenceKey=typeof documentPreferenceKeys[number];
type DocumentOverrides=Partial<Pick<Preferences,DocumentPreferenceKey>>;
const documentPreferenceSet=new Set<string>(documentPreferenceKeys);
const defaults: Preferences = {appIcon:'ink',autoSave:false,watchFiles:true,language:'ko',restoreSession:true,restoreUnsaved:true,grammarCheck:true,spellLanguage:'auto',personalDictionary:[],documentTheme:'default',documentOverrides:{},strictSyntax:false,emojiCompletion:true, boldMarker:'**',italicMarker:'*',bulletMarker:'-', autoLinks:true,smartPunctuation:false,renderHTML:true,defaultCodeLanguage:'',lastCodeLanguage:'',rememberCodeLanguage:true, fileSort:'name',pinnedFolders:[], customCSS:'', tabSize:4, pairing:true, spellcheck:true, richPaste:true, theme: 'system', fontSize: 18, fontFamily: 'theme', documentWidth: 780, lineHeight: 1.75, wrap: true, lineNumbers: false, focus: false, typewriter: false, mode: 'live', pandocPath: '', imageUploaderPath:'', imageUploaderArguments:'[]', mathNumbering:'none',mathPhysics:false, session:{paths:[],activePath:null,workspace:null},recentFiles:[],recentFolders:[], exportPresets: {} };
const labels: Record<string, string> = { footnote: 'Footnote', linkReference: 'Reference Link', bold: 'Bold', italic: 'Italic', underline: 'Underline', strike: 'Strikethrough', highlight: 'Highlight', code: 'Inline Code', sup: 'Superscript', sub: 'Subscript', comment: 'Comment', inlineMath: 'Inline Math', heading: 'Heading', quote: 'Quote', bullet: 'Bullet List', ordered: 'Numbered List', task: 'Task List', toggleTask: 'Toggle Task', indent: 'Indent', outdent: 'Outdent', horizontalRule: 'Horizontal Rule', codeBlock: 'Code Block', mathBlock: 'Math Block', toc: 'Contents', yaml: 'Front Matter', alert: 'Alert', link: 'Link', image: 'Image URL', clearFormat: 'Clear Formatting', insertParagraphBefore: 'Paragraph Before', insertParagraphAfter: 'Paragraph After', moveLineUp: 'Move Line Up', moveLineDown: 'Move Line Down', deleteBlock: 'Delete Block', deleteWord: 'Delete Word' };
const basename = (path: string) => path.split(/[\\/]/).pop() || path;
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const escapePattern = (source: string) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export class MoriApp {
  root: HTMLElement; client: NativeClient; editor: DocumentEditor; documents = new Map<string, DocumentRecord>(); activeId = ''; preferences: Preferences = { ...defaults }; workspace: string | null = null;
  private globalPreferences:Preferences={...defaults}; private localizer?:UILocalizer;
  private lastWindowState='';
  private lastNativeLanguage=''; private userThemes:DocumentTheme[]=[]; private rawThemes:{id:string;name:string;css:string}[]=[]; private draftRevisions=new Map<string,number>(); private closedDocuments:(NativeSnapshot&{keptDraft?:boolean})[]=[];
  private closingDocument=false;
  private proofreadingResult?:{source:string;result:ProofreadingResult};private proofreadingNote='';
  private outlineNavigator:OutlineNavigator;
  private lastOutlineSource='';
  private autoSaveTimers=new Map<string,ReturnType<typeof setTimeout>>();private autoSaveBlocked=new Set<string>();private externalWarnings=new Map<string,string>();private observerTimer:ReturnType<typeof setInterval>;private observing=false;
  private saveQueues=new Map<string,Promise<void>>();
  private searchGeneration=0;
  private searchSignature='';
  private typewriterFrame?:number;
  private typewriterGeneration=0;
  private disposed = false; private booting = true; private queuedCommands: EditorCommand[] = []; private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>(); private refreshTimer?: ReturnType<typeof setTimeout>; private nativePrevious: any; private nativeReceiver: any; private searchMatches: SearchMatch[] = []; private searchIndex = -1; private searchMode: 'document' | 'workspace' = 'document'; private searchJob = ''; private exportJob = ''; private recoveries: any[] = []; private knownFiles = new Map<string, any>(); private exportOptions: any = { paper: 'A4', margin: 20, width: 1024, quality: 0.9, outline: false, title: '', author: '', header: '', footer: '', splitPages: false, template:'',referenceDoc:'',css:'',extraArguments:[],tocDepth:3,postCommand:'',postArguments:[] }; private media: MediaQueryList; private mediaChange: () => void; private events = new AbortController(); private assetRoots = new Map<string, string>(); private unsavedAssetRoot?:string; private committedExportJobs=new Set<string>(); private lastExports=new Map<string,{format:string;options:Record<string,any>;destination:string}>(); private formatJobs=new Set<string>(); private preferenceWrites:Promise<unknown>=Promise.resolve(); private pendingAssetRewrites = new Map<string,{root:string;mapping:Map<string,string>;revision:number;path:string}>(); private toolJob = ''; private restoredIds = new Set<string>(); private toolOrigin?: MutationOrigin; private closePrevious:any;private closeReceiver:any;
  constructor(root: HTMLElement, client = new NativeClient()) {
    this.root = root; this.client = client; root.className = 'mori-app';
    this.closePrevious=(window as any).__moriBeforeClose;this.closeReceiver=(reason:'quit'|'window'='window')=>this.prepareForClose(reason);(window as any).__moriBeforeClose=this.closeReceiver;
    root.innerHTML = shell;
    this.editor = new DocumentEditor(this.query('.editor-host'), { onChange: (id, text) => this.changed(id, text), onSelection: () => this.selectionChanged(), onShortcut: action => this.perform(action), typeset: element => this.preview(element), openExternal: url => this.external(url), onPaste:event=>this.receivePaste(event), onDrop:event=>this.receiveDrop(event),proofreading:{check:text=>this.checkProofreading(text),enabled:()=>this.preferences.spellcheck||this.preferences.grammarCheck,uiLanguage:()=>this.preferences.language,onLearn:word=>this.learnWord(word),onResult:result=>{this.proofreadingResult={source:this.editor.text(),result};this.proofreadingNote=result.note??'';this.annotateProofreading();},onError:error=>this.report(error)} });
    this.editor.setLocked(true);
    this.outlineNavigator=new OutlineNavigator(this.query('.outline'),heading=>{if(this.preferences.mode==='reading')this.setMode('live');this.editor.select({from:heading.from,to:heading.to});});
    this.media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? ({ matches: false, addEventListener() {}, removeEventListener() {} } as any); this.mediaChange = () => this.applyPreferences(); this.media.addEventListener('change', this.mediaChange);
    this.nativePrevious = (window as any).__nativeCommand; this.nativeReceiver = (command: EditorCommand) => { if (this.booting) this.queuedCommands.push(command); else void this.nativeCommand(command).catch(error => this.report(error)); }; (window as any).__nativeCommand = this.nativeReceiver;
    root.addEventListener('click', event => { const target = (event.target as Element).closest<HTMLElement>('[data-action],[data-command]'); if (!target || target.closest('dialog,.markdown-body,.cm-content')) return; this.closeChromePopovers(); if (target.dataset.command) { const value = target.dataset.value; this.performCommand({ type: target.dataset.command, ...(value ? { value: target.dataset.command === 'heading' ? Number(value) : value } : {}) }); } else this.perform(target.dataset.action!); }, { signal: this.events.signal });
    root.addEventListener('pointerdown', event => { if (!(event.target as Element).closest('.chrome-popover')) this.closeChromePopovers(); }, { signal: this.events.signal });
    root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || (event.target as Element).closest('dialog')) return;
      const open = root.querySelector<HTMLDetailsElement>('.chrome-popover[open]');
      if (open) { event.preventDefault(); this.closeChromePopovers(); open.querySelector<HTMLElement>('summary')?.focus(); }
    }, { signal: this.events.signal });
    for (const popover of root.querySelectorAll<HTMLDetailsElement>('.chrome-popover')) popover.addEventListener('toggle', () => {
      if (popover.open) for (const other of root.querySelectorAll<HTMLDetailsElement>('.chrome-popover[open]')) if (other !== popover) other.open = false;
    }, { signal: this.events.signal });
    this.query<HTMLSelectElement>('[data-control="mode"]').addEventListener('change', event => this.setMode((event.target as HTMLSelectElement).value as Preferences['mode']));
    this.query<HTMLSelectElement>('[data-control="encoding"]').addEventListener('change',event=>void this.setEncoding((event.target as HTMLSelectElement).value).catch(error=>this.report(error)));
    this.query<HTMLSelectElement>('[data-control="line-ending"]').addEventListener('change', event => { const ending = (event.target as HTMLSelectElement).value as 'LF'|'CRLF'; this.editor.setLineEnding(ending); const doc = this.current(); if (doc) doc.lineEnding = ending; });
    for (const name of ['find', 'caseSensitive', 'regex', 'wholeWord']) this.query(`[data-control="${name}"]`).addEventListener(name === 'find' ? 'input' : 'change', () => {this.invalidateSearch();this.updateSearch();});
    this.query('[data-control="find"]').addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); if (this.searchMode === 'workspace') this.perform('workspace-search'); else this.nextMatch((event as KeyboardEvent).shiftKey ? -1 : 1); } });
    this.query<HTMLSelectElement>('[data-control="file-sort"]').addEventListener('change',event=>{this.preferences.fileSort=(event.target as HTMLSelectElement).value as Preferences['fileSort'];if(this.workspace)void this.loadDirectory(this.workspace,this.query('.file-tree')).catch(error=>this.report(error));void this.persist().catch(error=>this.report(error));});
    this.buildMenus();this.query('[data-menu="edit"] .menu-items').append(button('Check External Changes','check-files'));this.localizer=new UILocalizer(root); this.applyPreferences();
    this.observerTimer=setInterval(()=>{if(!this.booting&&!this.disposed&&this.preferences.watchFiles)void this.checkExternalFiles().catch(error=>this.report(error));},2000);
  }
  private query<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private ui(en:string,ko:string) { return this.preferences.language==='ko'?ko:en; }
  private closeChromePopovers() { for (const details of this.root.querySelectorAll<HTMLDetailsElement>('.chrome-popover[open],.chrome-popover .menu[open]')) details.open = false; }
  private current(): DocumentRecord | undefined { return this.documents.get(this.activeId); }
  private isDirty(doc:DocumentRecord):boolean {
    return doc.savedContent?doc.text!==doc.savedContent.text || doc.encoding!==doc.savedContent.encoding:doc.revision!==doc.savedRevision;
  }
  private historyAction(action:'undo'|'redo') {
    const document=this.root.ownerDocument,focused=document.activeElement;
    if(!(focused instanceof HTMLElement))return;
    if(focused!==this.editor.view.contentDOM){
      if(focused.closest('.cm-editor'))return;
      const editable=focused.closest('[contenteditable]');
      const ownsText=focused.matches('input,textarea') || focused.isContentEditable || !!editable && ['','true','plaintext-only'].includes((editable.getAttribute('contenteditable')??'false').toLowerCase());
      if(ownsText){document.execCommand?.(action);return;}
    }
    if(focused.closest('dialog') || this.root.querySelector('dialog[open]'))return;
    if(focused!==document.body && focused!==document.documentElement && !this.root.contains(focused))return;
    (action==='undo'?undo:redo)(this.editor.view);
  }
  private perform(action: string) { void this.action(action).catch(error => this.report(error)); }
  private performCommand(command: EditorCommand) { void this.runCommand(command).catch(error => this.report(error)); }
  private status(message: string, error = false) { if (this.disposed) return; this.query('[data-message]').textContent = message; const element = this.query('.message'); element.hidden = !message; element.classList.toggle('error', error); }
  report(error: unknown) { if (this.disposed) return; if (error instanceof NativeError && error.code === 'cancelled') { this.status('Cancelled.'); return; } this.status(error instanceof Error ? error.message : String(error), true); }
  private buildMenus() {
    for (const command of COMMANDS) {
      const name = ['link', 'image', 'footnote', 'linkReference', 'horizontalRule', 'codeBlock', 'mathBlock', 'toc', 'yaml', 'alert'].includes(command.type) ? 'insert' : ['indent','outdent','clearFormat','insertParagraphBefore','insertParagraphAfter','moveLineUp','moveLineDown','deleteBlock','deleteWord'].includes(command.type) ? 'edit' : 'format';
      const container = this.query(`[data-menu="${name}"] .menu-items`);
      const values = command.type === 'heading' ? [1,2,3,4,5,6] : command.type === 'alert' ? ['note','tip','important','warning','caution'] : [undefined];
      for (const value of values) { const control = button(value === undefined ? labels[command.type] : `${labels[command.type]} ${value}`); control.dataset.command = command.type; if (value !== undefined) control.dataset.value = String(value); container.append(control); }
    }
    for (const [label, action, menu] of [['Table…','table','insert'],['Insert Local Image…','insert-image','insert'],['Auto-indent Selection','autoindent-selected','edit'],['Auto-indent Document','autoindent-all','edit'],['Copy Code Block','copy-code','edit'],['Undo','undo','edit'],['Redo','redo','edit'],['Save As…','save-as','edit'],['Document File Tools…','document-files','edit'],['Repeat Export','repeat-export','edit'],['Copy Math as TeX','copy-math-tex','edit'],['Copy Math as MathML','copy-math-mathml','edit'],['Copy Math as SVG','copy-math-svg','edit'],['Save Math as TeX…','save-math-tex','edit'],['Save Math as MathML…','save-math-mathml','edit'],['Save Math as SVG…','save-math-svg','edit'],['Copy Diagram as SVG','copy-diagram-svg','edit'],['Save Diagram as SVG…','save-diagram-svg','edit'],['Duplicate','duplicate','edit'],['Copy Markdown','copy-markdown','edit'],['Copy Plain Text','copy-plain','edit'],['Copy HTML','copy-html','edit'],['Paste Plain Text','paste-plain','edit'],['Paste Rich Text','paste-rich','edit'],['Paste Clipboard Image','paste-image','edit'],['Find and Replace','find','edit'],['Recover Unsaved Documents','recoveries','edit'],['Run Tool…','run-tool','edit'],['Import Document…','import','insert'],['Upload Local Images','upload-images','insert'],['Upload Selected Image','upload-selected-image','edit'],['Reload Images','reload-images','edit'],['Image Properties and Preview…','image-properties','edit'],['Rename Selected Image…','rename-image','edit'],['Move Selected Image…','move-image','edit'],['Delete Selected Image…','delete-image','edit'],['Copy All Local Images…','copy-images','insert'],['Move All Local Images…','move-images','insert'],['Resolve Image References','resolve-image-references','edit'],['Images to HTML','images-to-html','edit'],['Images to Markdown','images-to-markdown','edit'],['Use Relative Image URLs','relative-image-urls','edit']]) this.query(`[data-menu="${menu}"] .menu-items`).append(button(label, action));
  }
  async start(): Promise<void> {
    try {
      const bootstrap: any = await this.client.call('bootstrap'); if(typeof bootstrap?.unsavedAssetRoot==='string' && bootstrap.unsavedAssetRoot.startsWith('/') && !bootstrap.unsavedAssetRoot.includes('\0'))this.unsavedAssetRoot=bootstrap.unsavedAssetRoot; this.globalPreferences=this.validPreferences(bootstrap?.settings ?? {});this.preferences=this.preferencesFor(); this.recoveries = Array.isArray(bootstrap?.recoveries) ? bootstrap.recoveries : []; this.restoredIds = new Set(this.recoveries.map(recovery => (recovery.snapshot ?? recovery).documentId)); this.applyPreferences();
      const warnings:string[]=[];try{await this.loadThemes();}catch(error){warnings.push(this.ui('Could not load user themes: ','사용자 테마를 불러오지 못했습니다: ')+(error instanceof Error?error.message:String(error)));}
      const session=this.preferences.session;
      if(this.preferences.restoreSession){
        if(session.documents){for(const entry of session.documents){try{const snapshot=normalizeSnapshot(await this.client.call('restoreDocument',{documentId:entry.documentId,path:entry.path}));const draft=this.restoredIds.has(snapshot.documentId);this.adopt(snapshot,draft);if(draft)this.draftRevisions.set(snapshot.documentId,snapshot.revision);const view=session.views?.[entry.documentId]??(entry.path?session.views?.[entry.path]:undefined);if(view)this.editor.restoreView(view);}catch(error){warnings.push(this.ui('Could not restore a document: ','이전 문서를 복원하지 못했습니다: ')+(error instanceof Error?error.message:String(error)));}}}
        else {
          if(this.preferences.restoreUnsaved)for(const recovery of this.recoveries){const saved=recovery.snapshot??recovery;try{this.adopt(normalizeSnapshot(await this.client.call('restoreDocument',{documentId:saved.documentId})),true);this.draftRevisions.set(saved.documentId,saved.revision);}catch(error){warnings.push(this.ui('Could not restore a draft: ','임시 문서를 복원하지 못했습니다: ')+(error instanceof Error?error.message:String(error)));}}
          for(const path of session.paths){try{if(![...this.documents.values()].some(doc=>doc.path===path))await this.openPath(path);if(session.views?.[path])this.editor.restoreView(session.views[path]);}catch(error){warnings.push(`Could not restore ${path}: ${error instanceof Error?error.message:String(error)}`);}}
        }
      }
      if(!this.documents.size)this.adopt(normalizeSnapshot(await this.client.call('createDocument')));
      const active=this.documents.get(session.activeDocumentId??'')??[...this.documents.values()].find(doc=>doc.path===session.activePath);if(active)this.adopt(active);
      if(this.preferences.restoreSession&&session.workspace){try{await this.openWorkspace(session.workspace,false);}catch(error){warnings.push(`Could not restore folder: ${error instanceof Error?error.message:String(error)}`);}}
      this.recoveries=this.recoveries.filter(recovery=>!this.documents.has((recovery.snapshot??recovery).documentId));
      this.status(warnings.length?warnings.join('\n'):this.recoveries.length ? `${this.recoveries.length} unsaved recovery ${this.recoveries.length === 1 ? 'document is' : 'documents are'} available in Edit.` : '',!!warnings.length); this.query('[data-action="retry"]').hidden = true;
    } catch (error) { this.report(error); this.query('[data-action="retry"]').hidden = false; }
    this.booting = false;this.editor.setLocked(!this.documents.size); this.captureSession(); for (const command of this.queuedCommands.splice(0)) await this.nativeCommand(command); this.refresh();this.sessionChanged(); if (!this.root.querySelector('dialog') && this.preferences.mode !== 'reading') this.editor.view.focus();
  }
  private validPreferences(value: any,validateOverrides=true): Preferences {
    const preferences = { ...defaults, ...value };preferences.language=preferences.language==='en'?'en':'ko'; preferences.session=normalizeSession(preferences.session);preferences.recentFiles=recordRecent(preferences.recentFiles,'');preferences.recentFolders=recordRecent(preferences.recentFolders,'');
    preferences.theme = ['system','light','dark'].includes(preferences.theme) ? preferences.theme : 'system';
    preferences.appIcon = preferences.appIcon === 'leaf' ? 'leaf' : 'ink';
    preferences.mathNumbering=['none','ams','all'].includes(preferences.mathNumbering)?preferences.mathNumbering:'none';
    preferences.mode = ['live','source','reading'].includes(preferences.mode) ? preferences.mode : 'live';
    for (const [key, low, high] of [['fontSize',12,36],['documentWidth',480,1400],['lineHeight',1.2,2.5]] as const) preferences[key] = typeof preferences[key] === 'number' && Number.isFinite(preferences[key]) ? Math.min(high, Math.max(low, preferences[key])) : defaults[key];
    for (const key of ['restoreSession','restoreUnsaved','grammarCheck','autoSave','watchFiles','wrap','lineNumbers','focus','typewriter','mathPhysics','pairing','spellcheck','richPaste','emojiCompletion','rememberCodeLanguage','autoLinks','smartPunctuation','renderHTML','strictSyntax'] as const) preferences[key] = typeof preferences[key] === 'boolean' ? preferences[key] : defaults[key];
    for(const key of ['imageUploaderPath','imageUploaderArguments'] as const)if(typeof preferences[key]!=='string')preferences[key]=defaults[key];
    for(const key of ['defaultCodeLanguage','lastCodeLanguage'] as const)preferences[key]=typeof preferences[key]==='string'&&/^[a-zA-Z0-9_+.-]{0,30}$/.test(preferences[key])?preferences[key]:'';preferences.boldMarker=preferences.boldMarker==='__'?'__':'**';preferences.italicMarker=preferences.italicMarker==='_'?'_':'*';preferences.bulletMarker=['-','+','*'].includes(preferences.bulletMarker)?preferences.bulletMarker:'-';preferences.pinnedFolders=recordRecent(preferences.pinnedFolders,'');preferences.fileSort=['name','modified','size'].includes(preferences.fileSort)?preferences.fileSort:'name';preferences.tabSize=Number.isInteger(preferences.tabSize)&&preferences.tabSize>=1&&preferences.tabSize<=16?preferences.tabSize:4;if(typeof preferences.customCSS!=='string')preferences.customCSS='';
    if (!['theme','system','serif','mono'].includes(preferences.fontFamily)) preferences.fontFamily = 'theme';
    preferences.documentTheme=typeof preferences.documentTheme==='string'&&/^(?:[a-z]+|user:[-a-zA-Z0-9_.]+)$/.test(preferences.documentTheme)?preferences.documentTheme:'default';
    preferences.spellLanguage=['auto','ko','en'].includes(preferences.spellLanguage)?preferences.spellLanguage:'auto';
    preferences.personalDictionary=Array.isArray(preferences.personalDictionary)?[...new Set(preferences.personalDictionary.filter((word:unknown):word is string=>typeof word==='string' && word.length>0 && word.length<=100 && !word.includes('\0')))].slice(0,5000):[];
    const overrides:Record<string,DocumentOverrides>={};
    if(validateOverrides && preferences.documentOverrides && typeof preferences.documentOverrides==='object' && !Array.isArray(preferences.documentOverrides))for(const [path,raw] of Object.entries(preferences.documentOverrides)){
      if((!path.startsWith('/') && !path.startsWith('id:')) || path.includes('\0') || !raw || typeof raw!=='object' || Array.isArray(raw))continue;
      const normalized=this.validPreferences({...raw,documentOverrides:{}},false),fields:Record<string,unknown>={};
      for(const key of documentPreferenceKeys)if(Object.hasOwn(raw,key) && typeof (raw as any)[key]===typeof defaults[key] && (raw as any)[key]===normalized[key])fields[key]=normalized[key];
      if(Object.keys(fields).length)overrides[path]=fields as DocumentOverrides;
    }
    preferences.documentOverrides=overrides;return preferences;
  }
  private preferenceKey(doc:DocumentRecord):string {return doc.path ?? `id:${doc.documentId}`;}
  private preferencesFor(doc:NativeSnapshot|undefined=this.current()):Preferences {
    const key=doc?(doc.path ?? `id:${doc.documentId}`):undefined;
    return {...this.globalPreferences,...(key?this.globalPreferences.documentOverrides[key]:{}),documentOverrides:this.globalPreferences.documentOverrides};
  }
  private syncGlobalPreferences() {
    const scoped=Object.fromEntries(documentPreferenceKeys.map(key=>[key,this.globalPreferences[key]]));
    this.globalPreferences={...this.preferences,...scoped,documentOverrides:this.globalPreferences.documentOverrides};
  }
  private hasDocumentPreferences(doc=this.current()):boolean {return !!doc && Object.hasOwn(this.globalPreferences.documentOverrides,this.preferenceKey(doc));}
  private setPreference(key:keyof Preferences,value:unknown,scoped=false,doc=this.current(),apply=true):boolean {
    if(scoped && (!doc || this.current()!==doc)){this.report(new Error('Switch back to the original document before editing its scoped settings.'));return false;}
    if(scoped && !documentPreferenceSet.has(key))return false;
    this.syncGlobalPreferences();const normalized=this.validPreferences({...this.globalPreferences,[key]:value},false)[key];
    if(scoped){const path=this.preferenceKey(doc!);this.globalPreferences.documentOverrides={...this.globalPreferences.documentOverrides,[path]:{...this.globalPreferences.documentOverrides[path],[key]:normalized}};}
    else this.globalPreferences={...this.globalPreferences,[key]:normalized};
    this.preferences=this.preferencesFor();if(apply)this.applyPreferences();return true;
  }
  private setDocumentScope(doc:DocumentRecord,enabled:boolean):boolean {
    if(this.current()!==doc){this.report(new Error('Switch back to the original document before changing its settings scope.'));return false;}
    this.syncGlobalPreferences();const key=this.preferenceKey(doc),next={...this.globalPreferences.documentOverrides};
    if(enabled && !next[key])next[key]=Object.fromEntries(documentPreferenceKeys.map(field=>[field,this.preferences[field]])) as DocumentOverrides;else if(!enabled)delete next[key];
    this.globalPreferences.documentOverrides=next;this.preferences=this.preferencesFor();this.applyPreferences();return true;
  }
  private moveDocumentPreferences(doc:DocumentRecord,from:string) {
    const to=this.preferenceKey(doc);if(from===to || !Object.hasOwn(this.globalPreferences.documentOverrides,from))return;
    const next={...this.globalPreferences.documentOverrides,[to]:this.globalPreferences.documentOverrides[from]};delete next[from];this.globalPreferences.documentOverrides=next;
    this.preferences=this.preferencesFor();if(this.current()===doc)this.applyPreferences();
  }
  private applyPreferences() {
    this.cancelTypewriterFrame();
    for(const timer of this.autoSaveTimers.values())clearTimeout(timer);this.autoSaveTimers.clear();
    this.syncGlobalPreferences();this.preferences=this.preferencesFor();const preferences = this.preferences;this.localizer?.setLanguage(preferences.language);configureMarkdown(preferences);
    const documentTheme=resolveDocumentTheme(preferences.documentTheme,this.userThemes);this.root.dataset.documentTheme=documentTheme.id;this.root.dataset.theme=documentTheme.appearance??(preferences.theme === 'system' ? (this.media?.matches ? 'dark' : 'light') : preferences.theme);
    let themeCSS=this.root.querySelector<HTMLStyleElement>('[data-theme-css]');if(!themeCSS){themeCSS=document.createElement('style');themeCSS.dataset.themeCss='true';this.root.append(themeCSS);}themeCSS.textContent=documentTheme.css;
    if(documentTheme.id.startsWith('user:')){const color=getComputedStyle(this.root).backgroundColor.match(/[\d.]+/g)?.map(Number);if(color&&color.length>=3&&(color.length<4||color[3]>0))this.root.dataset.theme=color[0]*.2126+color[1]*.7152+color[2]*.0722<145?'dark':'light';}
    const documentFont=preferences.fontFamily === 'theme' ? 'var(--theme-font, -apple-system, BlinkMacSystemFont, system-ui, sans-serif)' : preferences.fontFamily === 'serif' ? 'Georgia, ui-serif, serif' : preferences.fontFamily === 'mono' ? 'ui-monospace, Menlo, monospace' : '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';this.root.style.setProperty('--font-size', `${preferences.fontSize}px`); this.root.style.setProperty('--document-width', `${preferences.documentWidth}px`); this.root.style.setProperty('--line-height', String(preferences.lineHeight)); this.root.style.setProperty('--document-font',documentFont);
    for(const surface of this.root.querySelectorAll<HTMLElement>('.cm-content,.reading')){if(preferences.fontFamily==='theme')surface.style.removeProperty('font-family');else surface.style.setProperty('font-family',documentFont,'important');}
    if(this.lastNativeLanguage!==preferences.language){this.lastNativeLanguage=preferences.language;void this.client.call('uiLanguage',{language:preferences.language}).catch(error=>this.report(error));}
    this.root.dataset.focus = String(preferences.focus); this.root.dataset.typewriter = String(preferences.typewriter);
    this.query('[data-action="focus"]').setAttribute('aria-pressed', String(preferences.focus)); this.query('[data-action="typewriter"]').setAttribute('aria-pressed', String(preferences.typewriter));
    this.editor?.configure({ wrap: preferences.wrap, lineNumbers: preferences.lineNumbers,tabSize:preferences.tabSize,pairing:preferences.pairing,spellcheck:preferences.spellcheck,strictSyntax:preferences.strictSyntax,emojiCompletion:preferences.emojiCompletion,boldMarker:preferences.boldMarker,italicMarker:preferences.italicMarker,bulletMarker:preferences.bulletMarker });
    let css=this.root.querySelector<HTMLStyleElement>('[data-user-css]');if(!css){css=document.createElement('style');css.dataset.userCss='true';this.root.append(css);}css.textContent=preferences.customCSS; this.setMode(preferences.mode, false);
    if(this.editor){refreshProofreading(this.editor.view);this.annotateProofreading();if(this.current())this.renderSaveState();}
    for(const doc of this.documents.values())this.queueAutoSave(doc);
  }
  private persist(reset=false):Promise<unknown> {
    this.captureSession();this.syncGlobalPreferences();this.preferenceWrites=this.preferenceWrites.catch(()=>{}).then(()=>this.client.call('settings',{...(reset?{operation:'reset'}:{}),values:{...this.globalPreferences,session:normalizeSession(this.preferences.session)}}));return this.preferenceWrites;
  }
  private captureSession() {
    if(this.booting)return;
    const meaningful=[...this.documents.values()].filter(doc=>doc.path||doc.text||this.isDirty(doc)),views=Object.fromEntries(meaningful.flatMap(doc=>{const state=this.editor.captureView(doc.documentId);return state?[[doc.documentId,state]]:[];}));this.preferences.session=normalizeSession({paths:meaningful.flatMap(doc=>doc.path?[doc.path]:[]),activePath:this.current()?.path ?? null,activeDocumentId:this.activeId,workspace:this.workspace,documents:meaningful.map(doc=>({documentId:doc.documentId,path:doc.path})),draftRevisions:Object.fromEntries([...this.draftRevisions].filter(([id])=>meaningful.some(doc=>doc.documentId===id))),views});
  }
  private sessionChanged() {this.captureSession();if(!this.booting)void this.persist().catch(error=>this.report(error));}
  setMode(mode: Preferences['mode'], persist = true) {
    if(mode!==this.editor.view.dom.dataset.mode){this.invalidateSearch();this.cancelTypewriterFrame();}
    if(persist)this.setPreference('mode',mode,this.hasDocumentPreferences(),this.current(),false);else this.preferences.mode=mode; this.editor.mode(mode); this.query<HTMLSelectElement>('[data-control="mode"]').value = mode; this.query('.editor-host').hidden = mode === 'reading'; this.query('.reading').hidden = mode !== 'reading';
    this.query('[data-action="source"]').setAttribute('aria-pressed', String(mode === 'source'));
    if (mode === 'reading') this.renderReading(); if (persist) void this.persist().catch(error => this.report(error));
  }
  private renderReading() { const element = this.query('.reading'); element.innerHTML = renderMarkdown(this.editor.text());this.annotateProofreading(element); void this.preview(element).catch(error => this.report(error)); }
  private adopt(snapshot: NativeSnapshot, restored = false) {
    if(snapshot.documentId!==this.activeId)this.invalidateSearch();
    if(restored){this.restoredIds.add(snapshot.documentId);this.draftRevisions.set(snapshot.documentId,snapshot.revision);}
    if(!this.documents.has(snapshot.documentId))this.invalidateCloseApproval();
    if((restored || this.restoredIds.has(snapshot.documentId)) && !snapshot.path && this.unsavedAssetRoot)this.assetRoots.set(snapshot.documentId,this.unsavedAssetRoot);
    if (!this.documents.has(snapshot.documentId)) {
      const savedRevision=restored || this.restoredIds.has(snapshot.documentId)?-1:snapshot.savedDigest || snapshot.path || !snapshot.text?snapshot.revision:-1;
      this.documents.set(snapshot.documentId,{...snapshot,savedRevision,saving:0,...(savedRevision>=0?{savedContent:{text:snapshot.text,encoding:snapshot.encoding}}:{})});
    }
    this.syncGlobalPreferences();this.activeId = snapshot.documentId;this.preferences=this.preferencesFor(); this.editor.open(this.documents.get(this.activeId)!); this.applyPendingAssets(this.documents.get(this.activeId)!);this.applyPreferences(); this.invalidateToolReplacement(); this.refresh(); if(snapshot.path)this.preferences.recentFiles=recordRecent(this.preferences.recentFiles,snapshot.path);this.sessionChanged();
  }
  private changed(id: string, text: string) {
    const doc = this.documents.get(id); if (!doc) return; doc.text = text; doc.revision++; this.invalidateToolReplacement();
    if(id===this.activeId)this.invalidateSearch();
    doc.lineEnding=this.editor.lineEnding();
    if(!this.isDirty(doc))this.draftRevisions.delete(doc.documentId);
    this.invalidateCloseApproval();
    this.renderTabs(); this.renderSaveState();this.queueCheckpoint(doc);
    if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { if (!this.disposed) this.refreshContent(); }, 100);
  }
  private queueCheckpoint(doc:DocumentRecord) {
    this.queueAutoSave(doc);
    this.clearCheckpoint(doc.documentId);this.checkpointTimers.set(doc.documentId,setTimeout(()=>{
      this.checkpointTimers.delete(doc.documentId);if(!this.disposed && this.documents.get(doc.documentId)===doc){const revision=doc.revision;void this.client.call('checkpoint',{documentId:doc.documentId,text:this.publishedSource(doc),revision,force:false}).then(()=>{if(!this.disposed&&this.documents.get(doc.documentId)===doc){if(this.isDirty(doc))this.draftRevisions.set(doc.documentId,revision);else this.draftRevisions.delete(doc.documentId);this.renderSaveState();this.sessionChanged();}}).catch(error=>this.report(error));}
    },700));
  }
  private queueAutoSave(doc:DocumentRecord){
    const previous=this.autoSaveTimers.get(doc.documentId);if(previous)clearTimeout(previous);this.autoSaveTimers.delete(doc.documentId);
    if(this.disposed||this.booting||!this.preferences.autoSave||!doc.path||!this.isDirty(doc)||this.autoSaveBlocked.has(doc.documentId)||this.restoredIds.has(doc.documentId)||this.pendingAssetRewrites.has(doc.documentId))return;
    this.autoSaveTimers.set(doc.documentId,setTimeout(()=>{
      this.autoSaveTimers.delete(doc.documentId);
      if(this.disposed||!this.preferences.autoSave||this.documents.get(doc.documentId)!==doc||!this.isDirty(doc)||this.autoSaveBlocked.has(doc.documentId))return;
      if(doc.saving||this.formatJobs.has(doc.documentId)||(this.activeId===doc.documentId&&this.editor.view.compositionStarted)){this.queueAutoSave(doc);return;}
      void this.saveRecord(doc,false,false,true).catch(error=>this.report(error));
    },1000));
  }
  private async checkExternalFiles(){
    if(this.disposed||this.observing)return;this.observing=true;
    try{
      for(const doc of [...this.documents.values()]){
        if(!doc.path||doc.saving||this.formatJobs.has(doc.documentId))continue;
        const revision=doc.revision,digest=doc.savedDigest,path=doc.path;
        const observed=await this.client.call<{status:string;diskDigest:string|null}>('observeDocument',{documentId:doc.documentId});
        if(this.disposed||this.documents.get(doc.documentId)!==doc||doc.revision!==revision||doc.savedDigest!==digest||doc.path!==path||doc.saving)continue;
        if(!observed||!['unchanged','modified','missing'].includes(observed.status))throw new Error('The native file observer returned an invalid result.');
        if(observed.status==='unchanged'&&observed.diskDigest===digest){this.externalWarnings.delete(doc.documentId);continue;}
        const warning=observed.status+':'+observed.diskDigest;
        if(observed.status!=='missing'&&!this.isDirty(doc)&&this.activeId===doc.documentId&&!this.editor.view.compositionStarted&&!this.root.querySelector('dialog')){
          if(await this.reloadDocument(doc,true))this.status(`Reloaded external changes in ${basename(path)}.`);continue;
        }
        this.autoSaveBlocked.add(doc.documentId);
        if(this.externalWarnings.get(doc.documentId)!==warning){this.externalWarnings.set(doc.documentId,warning);this.status(observed.status==='missing'?`${basename(path)} is missing on disk. Its open source was kept; use Save to choose how to restore it.`:`${basename(path)} changed outside Inkleaf. Your open source was kept; use Save to resolve the change.`,true);}
      }
    }finally{this.observing=false;}
  }
  async setEncoding(encoding:string):Promise<void> {
    const origin=this.mutationOrigin(),doc=this.current()!;
    if(!['utf8','utf8bom','utf16le','utf16be'].includes(encoding))throw new Error('Unsupported document encoding.');
    if(encoding===doc.encoding)return;if(this.formatJobs.has(doc.documentId))throw new Error('Document format is already changing.');
    this.formatJobs.add(doc.documentId);this.invalidateCloseApproval();this.clearCheckpoint(doc.documentId);this.refresh();
    try {
      const revision=origin.revision+1,snapshot=normalizeSnapshot(await this.client.call('setDocumentFormat',{documentId:origin.documentId,text:origin.source,revision,encoding}));
      if(snapshot.documentId!==origin.documentId || snapshot.revision!==revision || snapshot.encoding!==encoding || snapshot.text!==origin.source)throw new Error('Native format response does not match the original document request.');
      if(this.documents.get(origin.documentId)!==doc)throw new Error('The original document closed while its format changed.');
      doc.encoding=encoding;doc.revision=doc.revision===origin.revision?revision:Math.max(doc.revision+1,revision);this.invalidateCloseApproval();
      this.queueCheckpoint(doc);this.status(`Encoding changed to ${encoding.toUpperCase()} for ${doc.path?basename(doc.path):'Untitled'}. Save to write the new byte format.`);
    } catch(error){if(this.documents.get(doc.documentId)===doc && this.isDirty(doc))this.queueCheckpoint(doc);throw error;}
    finally {this.formatJobs.delete(doc.documentId);if(!this.disposed)this.refresh();}
  }
  private cancelTypewriterFrame() {
    ++this.typewriterGeneration;
    if(this.typewriterFrame!==undefined)cancelAnimationFrame(this.typewriterFrame);
    this.typewriterFrame=undefined;
  }
  private selectionChanged(center=true) {
    if (!this.editor) return; this.invalidateToolReplacement(); const selection = this.editor.selection(); this.query('[data-selection]').textContent = selection.to > selection.from ? `${Array.from(this.editor.text().slice(selection.from, selection.to)).length} selected` : '';
    this.outlineNavigator?.update(this.lastOutlineSource,selection);
    if(!center)return;
    this.cancelTypewriterFrame();
    if(!this.preferences.typewriter || this.preferences.mode==='reading' || !this.current())return;
    const generation=this.typewriterGeneration,documentId=this.activeId,source=this.editor.view.state.doc,mode=this.preferences.mode,caret=this.editor.view.state.selection.main;
    this.typewriterFrame=requestAnimationFrame(()=>{
      if(generation!==this.typewriterGeneration)return;
      this.typewriterFrame=undefined;
      const current=this.editor.view.state.selection.main;
      if(this.disposed || !this.preferences.typewriter || this.preferences.mode!==mode || this.activeId!==documentId || this.editor.view.state.doc!==source || current.anchor!==caret.anchor || current.head!==caret.head)return;
      this.editor.view.dispatch({effects:EditorView.scrollIntoView(caret.head,{y:'center'})});
    });
  }
  private mutationOrigin(): MutationOrigin {
    const doc = this.current(); if (!doc) throw new Error('Open a document first.');
    return {documentId:doc.documentId,path:doc.path,revision:doc.revision,source:this.editor.text(),selection:this.editor.selection()};
  }
  private originCurrent(origin: MutationOrigin, checkSelection = true): boolean {
    const doc=this.current(), selection=this.editor.selection();
    return !this.disposed && doc?.documentId===origin.documentId && doc.path===origin.path && doc.revision===origin.revision && this.editor.text()===origin.source && (!checkSelection || (selection.from===origin.selection.from && selection.to===origin.selection.to));
  }
  private requireOrigin(origin: MutationOrigin) { if(this.closingDocument||!this.originCurrent(origin)) throw new Error('Document or selection changed while the operation was pending; no source was replaced.'); }
  private invalidateToolReplacement() {
    const replace=this.root.querySelector<HTMLButtonElement>('[data-tool-replace]');
    if(replace && this.toolOrigin && !this.originCurrent(this.toolOrigin)) replace.disabled=true;
  }
  private clearCheckpoint(id:string) { const timer=this.checkpointTimers.get(id); if(timer)clearTimeout(timer);this.checkpointTimers.delete(id); }
  private renderTabs() {
    const element = this.query('.document-tabs'); element.replaceChildren();
    for (const doc of this.documents.values()) { const row = document.createElement('div'); row.className = 'document-tab'; row.dataset.document = doc.documentId; row.dataset.dirty = String(this.isDirty(doc)); const tab = button(doc.path ? basename(doc.path) : this.ui('Untitled','새 문서')); tab.setAttribute('role','tab'); tab.setAttribute('aria-selected',String(doc.documentId === this.activeId)); tab.title = doc.path ?? 'Unsaved document'; tab.addEventListener('click',() => this.adopt(doc)); const close = button('×'); close.className = 'close-tab'; close.setAttribute('aria-label',`Close ${tab.textContent}`); close.addEventListener('click',() => void this.closeDocument(doc).catch(error => this.report(error))); row.append(tab,close); element.append(row); }
  }
  private renderSaveState() {
    const doc=this.current(),kept=doc && this.draftRevisions.get(doc.documentId)===doc.revision,dirty=doc && this.isDirty(doc);
    this.query('[data-save-state]').textContent=!doc?this.ui('No document open','열린 문서 없음'):doc.saving?this.ui('Saving…','파일 저장 중…'):!doc.path?kept?this.ui('Draft kept','임시 보관됨'):this.ui('Draft','임시 문서'):dirty?this.ui('Unsaved file changes','파일 저장 전')+(kept?this.ui(' · Draft kept',' · 임시 보관됨'):''):this.ui('Saved to file','파일에 저장됨');
    const indicator=this.query('[data-save-indicator]');indicator.textContent=doc?.saving?this.ui('Saving…','파일 저장 중…'):doc?.path?this.ui('Unsaved file changes','파일 저장 전'):kept?this.ui('Draft kept','임시 보관됨'):this.ui('Draft changes','임시 보관 중');indicator.hidden=!doc||(!doc.saving && (!doc.path?!doc.text:!dirty));
    const title=doc?.path?basename(doc.path):this.ui('Untitled','새 문서'),state={title,path:doc?.path??null,edited:!!dirty,appearance:this.root.dataset.theme},key=JSON.stringify(state);document.title=`${title} · Inkleaf`;
    if(key!==this.lastWindowState){this.lastWindowState=key;void this.client.call('setWindowTitle',state).catch(error=>this.report(error));}
  }

  private refresh() { const repeat=this.root.querySelector<HTMLButtonElement>('[data-action="repeat-export"]');if(repeat)repeat.disabled=!this.lastExports.has(this.activeId); this.renderTabs(); this.renderSaveState(); const doc = this.current(); if(doc){this.query<HTMLSelectElement>('[data-control="line-ending"]').value=doc.lineEnding==='CRLF'?'CRLF':'LF';this.query<HTMLSelectElement>('[data-control="encoding"]').value=doc.encoding;}this.query<HTMLSelectElement>('[data-control="encoding"]').disabled=!doc || this.formatJobs.has(doc.documentId); this.refreshContent(); }
  private refreshContent() {
    const text = this.editor.text(), stats = getStatistics(text); this.query('[data-statistics]').textContent = `${stats.words.toLocaleString()} words · ${stats.characters.toLocaleString()} characters · ${stats.lines.toLocaleString()} lines · ${stats.readingMinutes} min`;
    this.query('[data-word-count]').textContent = this.preferences.language === 'ko' ? `${stats.words.toLocaleString()} 단어` : `${stats.words.toLocaleString()} words`;
    this.lastOutlineSource=text;this.outlineNavigator.update(text,this.editor.selection());
    if (this.preferences.mode === 'reading') this.renderReading(); if (this.searchMode === 'document') this.updateSearch(); this.selectionChanged(false);
  }
  private assetSaveArguments(doc:DocumentRecord, source=doc.text) {
    const root=this.assetRoots.get(doc.documentId) ?? (doc.path ? parentPath(doc.path) : undefined);
    if(!root)return {};
    const plan=localImagePlan(source,root);
    return {assetRoot:root,imageReferences:plan.images.map((image,index)=>{const url=localImageURL(image.url,root);return {path:plan.imagePaths[index],from:image.urlFrom,to:image.urlTo,html:image.kind==='html',suffix:url.search+url.hash};})};
  }
  private publishedSource(doc:DocumentRecord,source=doc.text):string {
    const pending=this.pendingAssetRewrites.get(doc.documentId);if(!pending)return source;
    const plan=localImagePlan(source,pending.root),images=plan.images.filter((_,index)=>pending.mapping.has(plan.imagePaths[index]));
    const urls=plan.imagePaths.flatMap((path,index)=>{const target=pending.mapping.get(path);if(!target)return [];const url=localImageURL(plan.images[index].url,pending.root);return [target+url.search+url.hash];});
    return replaceImageURLs(source,images,urls);
  }
  private applyPendingAssets(doc:DocumentRecord) {
    const pending=this.pendingAssetRewrites.get(doc.documentId);if(!pending)return;
    const unchanged=doc.revision===pending.revision,text=this.publishedSource(doc,this.editor.text());
    this.pendingAssetRewrites.delete(doc.documentId);this.editor.replace(text);
    if(unchanged){doc.savedRevision=doc.revision;this.clearCheckpoint(doc.documentId);}this.assetRoots.delete(doc.documentId);
  }
  async save(as = false, force = false): Promise<void> {
    const doc=this.current(); if(!doc)throw new Error('Create or open a document before saving.');
    await this.saveRecord(doc,as,force);
  }
  private saveRecord(doc:DocumentRecord,as=false,force=false,automatic=false):Promise<void>{
    const previous=this.saveQueues.get(doc.documentId);
    const work=previous?previous.catch(()=>{}).then(()=>this.performSaveRecord(doc,as,force,automatic)):this.performSaveRecord(doc,as,force,automatic);
    this.saveQueues.set(doc.documentId,work);
    void work.finally(()=>{if(this.saveQueues.get(doc.documentId)===work)this.saveQueues.delete(doc.documentId);}).catch(()=>{});
    return work;
  }
  private async performSaveRecord(doc:DocumentRecord, as=false, force=false, automatic=false):Promise<void> {
    if(this.documents.get(doc.documentId)!==doc)throw new Error('The original document is no longer open.');
    if(automatic&&(!this.preferences.autoSave||this.autoSaveBlocked.has(doc.documentId)))return;
    const timer=this.autoSaveTimers.get(doc.documentId);if(timer)clearTimeout(timer);this.autoSaveTimers.delete(doc.documentId);
    const previousPreferenceKey=this.preferenceKey(doc),encoding=doc.encoding,saveAs=as || !doc.path, request={documentId:doc.documentId,text:doc.text,revision:doc.revision,force,...(saveAs ? this.assetSaveArguments(doc) : {expectedDigest:doc.savedDigest})};
    doc.saving++;this.renderSaveState();
    try {
      const result:any=await this.client.call(saveAs?'saveAs':'saveDocument',request);
      if(result && Number.isInteger(result.revision) && result.revision>=doc.savedRevision) {
        doc.savedContent={text:typeof result.text==='string'?result.text:request.text,encoding:typeof result.encoding==='string'?result.encoding:encoding};
        this.autoSaveBlocked.delete(doc.documentId);this.externalWarnings.delete(doc.documentId);
        if(doc.revision===request.revision)this.clearCheckpoint(doc.documentId);doc.savedRevision=result.revision;doc.savedDigest=result.savedDigest ?? doc.savedDigest;doc.path=result.path ?? doc.path;this.moveDocumentPreferences(doc,previousPreferenceKey);this.restoredIds.delete(doc.documentId);
        if(saveAs && typeof result.text==='string' && result.text!==request.text && doc.path) {
          const root=(request as any).assetRoot as string,oldPlan=localImagePlan(request.text,root),newImages=discoverImages(result.text),oldImages=discoverImages(request.text);
          const mapping=new Map(oldPlan.images.map((image,index)=>[oldPlan.imagePaths[index],(newImages[oldImages.findIndex(old=>old.from===image.from)]?.url ?? image.url).replace(/[?#].*$/,'')]));
          this.pendingAssetRewrites.set(doc.documentId,{root,mapping,revision:request.revision,path:doc.path});
          if(this.activeId===doc.documentId)this.applyPendingAssets(doc);else {doc.savedRevision=-1;this.assetRoots.set(doc.documentId,root);}
        } else if(saveAs && doc.path)this.assetRoots.delete(doc.documentId);
      }
      if(!this.isDirty(doc))this.draftRevisions.delete(doc.documentId);if(doc.path)this.preferences.recentFiles=recordRecent(this.preferences.recentFiles,doc.path);await this.persist();
      if(!automatic||this.activeId===doc.documentId)this.status(!this.isDirty(doc)?'':'An earlier revision was saved. Current changes are still unsaved.');
    } catch(error) {
      if(automatic){this.autoSaveBlocked.add(doc.documentId);this.status(`Auto-save paused for ${basename(doc.path??'document')}: ${error instanceof Error?error.message:String(error)}. Use Save to resolve it.`,true);}
      else if(error instanceof NativeError && error.code.toLowerCase().includes('conflict'))this.conflict(doc,saveAs);else throw error;
    } finally {doc.saving--;if(!this.disposed){this.renderTabs();this.renderSaveState();this.queueAutoSave(doc);}}
  }
  private conflict(doc:DocumentRecord, destination=false) {
    const dialog=modal(this.root,destination?'The save destination conflicts':'The file changed on disk'),description=document.createElement('p');
    if(destination) {
      description.textContent='The destination was not saved. Choose the Save As destination again; replacement consent applies only to the file selected in that dialog.';
      const retry=button('Choose Destination Again');retry.addEventListener('click',()=>{dialog.close();void this.saveRecord(doc,true).catch(error=>this.report(error));});dialog.body.append(description);dialog.footer.append(retry);return;
    }
    description.textContent='Your edits are still open. Reload the disk version, save a separate copy, or explicitly overwrite the changed file.';dialog.body.append(description);
    const reload=button('Reload Disk'),copy=button('Save Separate Copy'),overwrite=button('Overwrite Disk');
    reload.addEventListener('click',()=>{dialog.close();void this.reloadDocument(doc).catch(error=>this.report(error));});
    copy.addEventListener('click',()=>{dialog.close();void this.saveRecord(doc,true).catch(error=>this.report(error));});
    overwrite.addEventListener('click',()=>{dialog.close();void this.saveRecord(doc,false,true).catch(error=>this.report(error));});dialog.footer.append(reload,copy,overwrite);
  }
  private async reloadDocument(doc:DocumentRecord,automatic=false):Promise<boolean> {
    if(this.documents.get(doc.documentId)!==doc)throw new Error('The original document is no longer open.');
    this.adopt(doc);const origin=this.mutationOrigin();this.clearCheckpoint(doc.documentId);
    const snapshot=normalizeSnapshot(await this.client.call('reloadDocument',{documentId:doc.documentId,revision:doc.revision+1}));
    if(automatic&&(!this.originCurrent(origin,false)||this.isDirty(doc)||doc.saving||this.formatJobs.has(doc.documentId)||this.root.querySelector('dialog')))return false;
    if(this.editor.view.compositionStarted){if(automatic)return false;throw new Error('Finish composing text before reloading this document.');}
    if(!this.originCurrent(origin,false))throw new Error('The document changed while the disk version was loading; your open edits were kept.');if(snapshot.documentId!==doc.documentId)throw new Error('Reload returned a different document identity.');
    this.editor.replace(snapshot.text,this.editor.selection(),snapshot.lineEnding);Object.assign(doc,snapshot,{savedRevision:snapshot.revision,savedContent:{text:snapshot.text,encoding:snapshot.encoding}});this.clearCheckpoint(doc.documentId);this.restoredIds.delete(doc.documentId);this.assetRoots.delete(doc.documentId);this.autoSaveBlocked.delete(doc.documentId);this.externalWarnings.delete(doc.documentId);this.refresh();
    return true;
  }
  private async closeDocument(doc:DocumentRecord,createWhenEmpty=true):Promise<boolean> {
    if(doc.saving)await this.saveQueues.get(doc.documentId);
    if(!this.isDirty(doc)){
      const revision=doc.revision;
      if(revision!==doc.savedRevision)await this.client.call('checkpoint',{documentId:doc.documentId,text:this.publishedSource(doc),revision});
      if(doc.revision===revision&&!this.isDirty(doc)){await this.removeDocument(doc,{},createWhenEmpty);return true;}
    }
    return await new Promise<boolean>(resolve=>{
      const dialog=modal(this.root,'Close unsaved document?'),message=document.createElement('p');message.textContent=this.ui('Save to a file, keep a local draft, or discard the current changes.','파일에 저장하거나 임시 문서로 보관할 수 있습니다. 내용을 버리면 현재 변경 사항을 삭제합니다.');dialog.body.append(message);
      let settled=false;const finish=(accepted:boolean)=>{if(settled)return;settled=true;resolve(accepted);dialog.close();};
      const cancel=button('Cancel'),keep=button('Keep Draft'),save=button('Save to File and Close'),discard=button('Discard and Close');
      const operate=(fn:()=>Promise<boolean>)=>{for(const control of [keep,save,discard])control.disabled=true;void fn().then(accepted=>{if(accepted)finish(true);else for(const control of [keep,save,discard])control.disabled=false;}).catch(error=>{for(const control of [keep,save,discard])control.disabled=false;this.report(error);});};
      cancel.addEventListener('click',()=>finish(false));
      keep.addEventListener('click',()=>operate(async()=>{await this.client.call('checkpoint',{documentId:doc.documentId,text:this.publishedSource(doc),revision:doc.revision});await this.removeDocument(doc,{keepRecovery:true,revision:doc.revision},createWhenEmpty);return true;}));
      save.addEventListener('click',()=>operate(async()=>{this.adopt(doc);await this.saveRecord(doc);if(this.isDirty(doc))return false;await this.removeDocument(doc,{},createWhenEmpty);return true;}));
      discard.addEventListener('click',()=>operate(async()=>{await this.removeDocument(doc,{discardRecovery:true},createWhenEmpty);return true;}));dialog.footer.append(cancel,keep,discard,save);
      dialog.element.addEventListener('mori-dismiss',()=>finish(false));
    });
  }
  private async removeDocument(doc:DocumentRecord,options:Record<string,unknown>={},createWhenEmpty=true) {
    if(this.closingDocument)throw new Error(this.ui('Another document is closing.','다른 문서를 닫고 있습니다.'));this.closingDocument=true;this.editor.setLocked(true);
    try{await this.client.call('closeDocument',{documentId:doc.documentId,...options});}finally{this.closingDocument=false;this.editor.setLocked(false);}
    this.closedDocuments.push({...doc,keptDraft:options.keepRecovery===true});if(this.closedDocuments.length>30)this.closedDocuments.shift();
    this.documents.delete(doc.documentId);this.clearFileWork(doc.documentId);this.clearCheckpoint(doc.documentId);this.draftRevisions.delete(doc.documentId);this.invalidateCloseApproval();this.editor.close(doc.documentId);this.assetRoots.delete(doc.documentId);this.pendingAssetRewrites.delete(doc.documentId);this.lastExports.delete(doc.documentId);this.restoredIds.delete(doc.documentId);this.recoveries=this.recoveries.filter(recovery=>(recovery.snapshot??recovery).documentId!==doc.documentId);if(options.keepRecovery===true)this.recoveries.push({...doc});
    if(this.activeId===doc.documentId){const next=this.documents.values().next().value;if(next)this.adopt(next);else{this.activeId='';this.editor.clear();if(createWhenEmpty)await this.action('new');}}
    this.refresh();this.sessionChanged();
  }

  private showPanel(name: 'files'|'outline'|'search') { this.query('.sidebar').hidden = false; this.query('[data-action="sidebar"]').setAttribute('aria-expanded','true'); for (const panel of this.root.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== name; for (const control of this.root.querySelectorAll<HTMLElement>('.sidebar-tabs button')) control.setAttribute('aria-pressed',String(control.dataset.action === (name === 'search' ? 'find' : name))); }
  private searchOptions(): SearchOptions { return Object.fromEntries(['caseSensitive','regex','wholeWord'].map(name => [name,this.query<HTMLInputElement>(`[data-control="${name}"]`).checked])); }
  private searchContext() {
    return JSON.stringify({documentId:this.activeId,source:this.editor.text(),query:this.query<HTMLInputElement>('[data-control="find"]').value,options:this.searchOptions(),mode:this.searchMode,editorMode:this.preferences.mode,workspace:this.workspace});
  }
  private invalidateSearch() {
    ++this.searchGeneration;this.searchSignature='';this.searchMatches=[];this.searchIndex=-1;
    this.query('[data-search-results]').replaceChildren();
    for(const name of ['replace-one','replace-all','next-match','previous-match'])this.query<HTMLButtonElement>(`[data-action="${name}"]`).disabled=true;
    const jobId=this.searchJob;this.searchJob='';
    if(jobId)void this.client.call('cancelSearch',{jobId}).catch(()=>{});
    if(this.searchMode==='workspace')this.query('[data-search-status]').textContent=this.ui('Search changed. Choose Search Folder to search again.','검색 조건이 바뀌었습니다. 폴더 검색을 다시 실행하세요.');
    this.query('[data-action="cancel-job"]').hidden=!(this.exportJob || this.toolJob || this.searchJob);
  }
  private updateSearch() {
    if (this.searchMode === 'workspace') return; const query = this.query<HTMLInputElement>('[data-control="find"]').value;
    const signature=this.searchContext();if(signature!==this.searchSignature){this.searchIndex=-1;this.searchSignature=signature;}
    try { this.searchMatches = query ? findMatches(this.editor.text(),query,this.searchOptions()) : []; this.searchIndex = Math.min(this.searchIndex,this.searchMatches.length - 1); this.query('[data-search-status]').textContent = query ? `${this.searchMatches.length} ${this.searchMatches.length === 1 ? 'match' : 'matches'} in this document.` : 'Enter text to search this document.'; this.query('[data-search-results]').replaceChildren(); for (const name of ['replace-one','replace-all','next-match','previous-match']) this.query<HTMLButtonElement>(`[data-action="${name}"]`).disabled = !this.searchMatches.length; }
    catch (error) { this.searchMatches = []; this.query('[data-search-status]').textContent = `Invalid regular expression: ${error instanceof Error ? error.message : error}`; for (const name of ['replace-one','replace-all','next-match','previous-match']) this.query<HTMLButtonElement>(`[data-action="${name}"]`).disabled = true; }
  }
  private nextMatch(direction: number) { if(this.searchMode!=='document')return;this.updateSearch();if (!this.searchMatches.length) return; this.searchIndex = this.searchIndex<0?(direction<0?this.searchMatches.length-1:0):(this.searchIndex + direction + this.searchMatches.length) % this.searchMatches.length; this.editor.select(this.searchMatches[this.searchIndex]); this.query('[data-search-status]').textContent = `Match ${this.searchIndex + 1} of ${this.searchMatches.length}.`; }
  private replaceSearch(all: boolean) {
    if(this.searchMode!=='document')return;
    this.updateSearch();
    const query = this.query<HTMLInputElement>('[data-control="find"]').value, replacement = this.query<HTMLInputElement>('[data-control="replacement"]').value, options = this.searchOptions(); if (!query || !this.searchMatches.length) return;
    let text = this.editor.text(); if (all) text = replaceMatches(text,query,replacement,options); else { const match = this.searchMatches[Math.max(0,this.searchIndex)]; if (options.regex) text = replaceMatches(text,`(?<=^${escapePattern(text.slice(0,match.from))})(?:${query})`,replacement,{...options,wholeWord:false}); else text = text.slice(0,match.from) + replacement + text.slice(match.to); }
    this.editor.replace(text); this.updateSearch();
  }
  private async openPath(path: string) { const opened=[...this.documents.values()].find(doc=>doc.path===path);if(opened){this.adopt(opened);return;} const snapshot = normalizeSnapshot(await this.client.call('openDocument',{path})); this.adopt(snapshot); }
  private async loadDirectory(path: string, element: HTMLElement): Promise<void> {
    element.textContent = 'Loading folder…'; const response: any = await this.client.call('listDirectory',{path}); const entries = (Array.isArray(response) ? response : response?.entries ?? []).slice().sort((a:any,b:any)=>{if(!!a.isDirectory!==!!b.isDirectory)return a.isDirectory?-1:1;const key=this.preferences.fileSort;if(key!=='name'){const diff=Number(b[key]??0)-Number(a[key]??0);if(diff)return diff;}return String(a.name).localeCompare(String(b.name),undefined,{numeric:true,sensitivity:'base'});}); element.replaceChildren();
    if (!entries.length) { const empty = document.createElement('p'); empty.textContent = 'This folder is empty.'; element.append(empty); }
    for (const entry of entries) { if (!entry || typeof entry.path !== 'string' || typeof entry.name !== 'string') continue; this.knownFiles.set(entry.path,entry); const row = document.createElement('div'), control = button(entry.name); row.className = 'file-entry'; control.dataset.path = entry.path; control.setAttribute('role','treeitem'); control.title = entry.path; row.append(control);
      if (entry.isDirectory) { control.className = 'directory'; control.setAttribute('aria-expanded','false'); const children = document.createElement('div'); children.className = 'directory-children'; children.hidden = true; children.setAttribute('role','group'); row.append(children); let loaded = false; control.addEventListener('click',() => { children.hidden = !children.hidden; control.setAttribute('aria-expanded',String(!children.hidden)); if (!loaded) { loaded = true; void this.loadDirectory(entry.path,children).catch(error => { loaded = false; children.textContent = 'Folder could not be read. Click its name to try again.'; this.report(error); }); } }); }
      else control.addEventListener('click',() => void this.openPath(entry.path).catch(error => this.report(error))); element.append(row);
    }
  }
  private async openWorkspace(path:string, reveal=true) {
    this.invalidateSearch();
    this.workspace=path;this.knownFiles.clear();if(reveal)this.showPanel('files');this.query('[data-folder-label]').textContent=path;
    await this.loadDirectory(path,this.query('.file-tree'));this.refreshFileControls();this.preferences.recentFolders=recordRecent(this.preferences.recentFolders,path);this.sessionChanged();
  }
  private refreshFileControls(){const pin=this.query<HTMLButtonElement>('[data-action="pin-folder"]'),sort=this.query<HTMLSelectElement>('[data-control="file-sort"]');pin.disabled=sort.disabled=!this.workspace;pin.textContent=this.workspace&&this.preferences.pinnedFolders.includes(this.workspace)?'Unpin Folder':'Pin Folder';sort.value=this.preferences.fileSort;}
  private async chooseFolder() { const result:any=await this.client.call('chooseWorkspace');const path=typeof result==='string'?result:result?.path;if(path)await this.openWorkspace(path); }

  private async workspaceSearch() {
    if (!this.workspace) { await this.chooseFolder(); if (!this.workspace) return; }
    this.invalidateSearch();this.searchMode = 'workspace'; this.showPanel('search'); const query = this.query<HTMLInputElement>('[data-control="find"]').value; if (!query) { this.query('[data-search-status]').textContent = 'Enter text, then choose Search Folder.'; this.query('[data-control="find"]').focus(); return; }
    const options = this.searchOptions(),workspace=this.workspace,generation=this.searchGeneration,context=this.searchContext();const jobId = `search-${Date.now()}-${generation}`; this.searchJob = jobId; this.query('[data-search-status]').textContent = 'Searching folder…'; this.query('[data-action="cancel-job"]').hidden = false;
    const current=()=>!this.disposed && generation===this.searchGeneration && this.searchMode==='workspace' && this.searchContext()===context;
    try { const response: any = await this.client.call('searchWorkspace',{path:workspace,query,caseSensitive:!!options.caseSensitive,regex:!!options.regex,wholeWord:!!options.wholeWord,limit:200,jobId}); if (!current() || this.searchJob !== jobId) return; const matches = Array.isArray(response) ? response : response?.matches ?? []; const results = this.query('[data-search-results]'); results.replaceChildren(); this.query('[data-search-status]').textContent = `${matches.length} folder matches${matches.length >= 200 ? ' (limit reached)' : ''}.`; for (const match of matches) { const control = button(`${basename(match.path)}:${match.line} ${match.text.trim()}`); control.title = match.path; control.addEventListener('click',() => {if(!current())return;void (async()=>{
        const opened=[...this.documents.values()].find(doc=>doc.path===match.path);
        const snapshot=opened??normalizeSnapshot(await this.client.call('openDocument',{path:match.path}));
        if(!current())return;
        this.adopt(snapshot);
        const line=sourceLines(this.editor.text())[Math.max(0,match.line-1)],from=match.from??0,to=match.to??0;
        if(line && line.text===match.text && Number.isInteger(from) && Number.isInteger(to) && from>=0 && to>=from && to<=line.text.length)
          this.editor.select({from:line.from+from,to:line.from+to});
      })().catch(error=>this.report(error));}); results.append(control); } }
    catch(error){if(current())throw error;}
    finally { if (this.searchJob === jobId) this.searchJob = ''; if (!this.disposed) this.query('[data-action="cancel-job"]').hidden = !(this.exportJob || this.toolJob || this.searchJob); }
  }
  private async quickOpen() {
    if (!this.workspace && !this.documents.size) throw new Error('Open a folder or document first.'); const dialog = modal(this.root,'Quick Open'), query = input('search'); query.placeholder = 'Search file names'; dialog.body.append(field('File name',query)); const results = document.createElement('div'); results.className = 'quick-results'; const note = document.createElement('p'); dialog.body.append(results,note);
    const render = () => { results.replaceChildren(); const files = [...this.knownFiles.values()].filter(entry => !entry.isDirectory); const recent=this.preferences.recentFiles.map(path=>({path,name:basename(path)})); const opened = [...this.documents.values()].filter(doc => doc.path).map(doc => ({path:doc.path,name:basename(doc.path!)})); const unique = new Map([...recent,...opened,...files].map(file => [file.path,file])); const matches = [...unique.values()].filter(file => file.name.normalize('NFC').toLowerCase().includes(query.value.normalize('NFC').toLowerCase())).slice(0,100); for (const file of matches) { const control = button(file.name); control.title = file.path; control.addEventListener('click',() => { dialog.close(); void this.openPath(file.path).catch(error => this.report(error)); }); results.append(control); } if (!matches.length) results.textContent = 'No matching files. Open a folder to search more documents.'; };
    query.addEventListener('input',render); render();const folders=document.createElement('div');for(const path of new Set([...this.preferences.pinnedFolders,...this.preferences.recentFolders])){const control=button(`${this.preferences.pinnedFolders.includes(path)?'Pinned':'Folder'}: ${basename(path)}`);control.title=path;control.addEventListener('click',()=>{dialog.close();void this.openWorkspace(path).catch(error=>this.report(error));});folders.append(control);}dialog.body.append(folders);
    if (this.workspace) { note.textContent = 'Scanning file names…'; const queue = [this.workspace]; let directories = 0; while (queue.length && directories < 200 && dialog.element.isConnected) { const path = queue.shift()!; const entries: any = await this.client.call('listDirectory',{path}); directories++; for (const entry of Array.isArray(entries) ? entries : entries?.entries ?? []) { this.knownFiles.set(entry.path,entry); if (entry.isDirectory) queue.push(entry.path); } } if (dialog.element.isConnected) { note.textContent = queue.length ? 'Directory limit reached. Browse deeper folders to add their files.' : `${this.knownFiles.size} paths scanned.`; render(); } }
  }
  private documentFileTools() {
    const doc=this.current();if(!doc?.path)throw new Error('Save a document before managing its file.');
    const dialog=modal(this.root,'Document File Tools');dialog.body.textContent=doc.path;
    for(const [label,operation] of [['Rename File','rename'],['Move File','move'],['Move to Trash','trash']] as const){
      const control=button(label);control.addEventListener('click',()=>{dialog.close();this.documentFileDialog(doc,operation);});dialog.footer.append(control);
    }
  }
  private documentFileDialog(doc:DocumentRecord,operation:'rename'|'move'|'trash') {
    if(this.documents.get(doc.documentId)!==doc || !doc.path)throw new Error('The selected document is no longer open.');
    const sourcePath=doc.path,origin=this.mutationOrigin(),label=operation==='rename'?'Rename File':operation==='move'?'Move File':'Move to Trash';
    const dialog=modal(this.root,label),destination=input('text',operation==='rename'?basename(sourcePath):sourcePath),note=document.createElement('p');
    note.textContent=operation==='trash'?`Move ${sourcePath} to the macOS Trash? Current edits must be saved first. This changes the file on disk.`:`Change ${sourcePath}. Current edits must be saved first. Existing destination files will never be overwritten.`;
    dialog.body.append(note);if(operation!=='trash')dialog.body.append(field(operation==='rename'?'New filename':'Destination file (absolute path)',destination));
    const apply=button(label);apply.addEventListener('click',()=>{apply.disabled=true;void(async()=>{
      this.requireOrigin(origin);if(doc.path!==sourcePath)throw new Error('The document file path changed. Reopen File Tools.');
      const target=operation==='trash'?undefined:operation==='rename'?`${parentPath(sourcePath).replace(/\/$/,'')}/${destination.value}`:destination.value;
      if(operation==='rename' && (!destination.value || /[\/\\]/.test(destination.value) || ['.','..'].includes(destination.value)))throw new Error('Enter a filename without directory separators.');
      if(target && (!target.startsWith('/') || target.includes('\0')))throw new Error('Destination must be an absolute file path.');
      if(target && parentPath(target)!==parentPath(sourcePath) && localImagePlan(doc.text,parentPath(sourcePath)).images.length)throw new Error('This document has local images. Use Save As to publish them into the new folder, then explicitly trash the original file.');
      if(doc.revision!==doc.savedRevision)await this.saveRecord(doc);if(doc.revision!==doc.savedRevision)throw new Error('The document must be saved before changing its file.');
      const result:any=await this.client.call('manageFile',{operation,documentId:doc.documentId,path:sourcePath,...(target?{destination:target}:{})});
      if(!result?.document)throw new Error('Native file operation returned no updated document binding.');
      const snapshot=normalizeSnapshot(result.document);if(snapshot.documentId!==doc.documentId)throw new Error('Native file operation changed document identity.');
      this.knownFiles.delete(sourcePath);
      if(operation==='trash'){this.preferences.recentFiles=this.preferences.recentFiles.filter(path=>path!==sourcePath);await this.removeDocument(doc);}
      else {doc.path=snapshot.path;this.moveDocumentPreferences(doc,sourcePath);doc.savedDigest=snapshot.savedDigest;this.preferences.session=moveSessionPath(this.preferences.session,sourcePath,snapshot.path!);this.preferences.recentFiles=recordRecent(this.preferences.recentFiles.filter(path=>path!==sourcePath),snapshot.path!);this.assetRoots.delete(doc.documentId);this.refresh();}
      if(this.workspace){this.knownFiles.clear();await this.loadDirectory(this.workspace,this.query('.file-tree'));}
      await this.persist();dialog.close();this.status(operation==='trash'?'File moved to Trash.':`File ${operation==='rename'?'renamed':'moved'}.`);
    })().catch(error=>{apply.disabled=false;this.report(error);});});dialog.footer.append(apply);
  }
  private async checkProofreading(text:string):Promise<ProofreadingResult> {
    const automatic=/\p{Script=Hangul}/u.test(text)?'ko':'en',language=this.preferences.spellLanguage==='auto'?automatic:this.preferences.spellLanguage;
    const result=normalizeProofreadingResult(text,await this.client.call('proofread',{operation:'check',text,language,ignoredWords:this.preferences.personalDictionary}));
    if(language==='ko'&&/[a-zA-Z]/.test(text)){
      const english=normalizeProofreadingResult(text,await this.client.call('proofread',{operation:'check',text,language:'en',ignoredWords:this.preferences.personalDictionary}));
      const englishIssue=(issue:ProofreadingIssue)=>/^[a-zA-Z][a-zA-Z'’ -]*$/.test(text.slice(issue.from,issue.to));
      result.issues=result.issues.filter(issue=>issue.kind!=='spelling'||!englishIssue(issue));
      for(const issue of english.issues.filter(englishIssue)){
        const same=result.issues.findIndex(other=>other.from===issue.from&&other.to===issue.to&&other.kind===issue.kind);
        if(same>=0)result.issues[same]=issue;else if(!result.issues.some(other=>other.from<issue.to&&other.to>issue.from))result.issues.push(issue);
      }
    }
    result.issues=result.issues.filter(issue=>issue.kind==='spelling'?this.preferences.spellcheck:this.preferences.grammarCheck).sort((a,b)=>a.from-b.from||a.to-b.to);return result;
  }
  private async learnWord(word:string) {const result:any=await this.client.call('proofread',{operation:'learn',word});this.setPreference('personalDictionary',result?.personalDictionary??[...this.preferences.personalDictionary,word]);await this.persist();}
  private dictionaryDialog() {
    const selection=this.editor.selection(),selected=this.editor.text().slice(selection.from,selection.to).trim(),dialog=modal(this.root,'Dictionary'),word=input('text',selected),definition=document.createElement('div');definition.className='dictionary-definition';definition.setAttribute('role','status');word.dataset.dictionaryWord='true';definition.dataset.dictionaryDefinition='true';dialog.body.append(field('Word',word),definition);
    const lookup=button('Look Up');const run=()=>{const term=word.value.trim();if(!term){word.focus();return;}lookup.disabled=true;definition.textContent=this.ui('Looking up the local dictionary…','설치된 사전에서 찾는 중…');void this.client.call<any>('proofread',{operation:'lookup',text:term}).then(result=>{if(!dialog.element.isConnected)return;definition.textContent=result?.definition||this.ui('No definition was found in the installed dictionaries. Try another word.','설치된 사전에서 뜻을 찾지 못했습니다. 다른 단어를 입력해 보세요.');if(result?.note){const note=document.createElement('p');note.textContent=result.note;definition.append(note);}for(const suggestion of result?.suggestions??[]){const control=button(suggestion);control.dataset.userContent='true';control.addEventListener('click',()=>{word.value=suggestion;run();});definition.append(control);}}).catch(error=>{if(dialog.element.isConnected)definition.textContent=error instanceof Error?error.message:String(error);}).finally(()=>{lookup.disabled=false;});};lookup.addEventListener('click',run);word.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();run();}});dialog.footer.append(lookup);if(selected)run();
  }
  private annotateProofreading(element?:HTMLElement) {
    const current=this.proofreadingResult;if(!current)return;
    const source=this.editor.text(),result={...current.result,issues:current.source===source?current.result.issues.filter(issue=>issue.kind==='spelling'?this.preferences.spellcheck:this.preferences.grammarCheck):[]};
    for(const surface of element?[element]:[...this.root.querySelectorAll<HTMLElement>('.live-block,.reading')]){
      const from=surface.dataset.sourceOffset?Number(surface.dataset.sourceOffset):0;
      annotatePreview(surface,source,result,{from,onIssue:issue=>{if(this.preferences.mode==='reading')this.setMode('live');this.editor.select({from:issue.from,to:issue.to});showProofreadingSuggestions(this.editor.view);}});
    }
  }
  private async loadThemes() {
    const result:any=await this.client.call('themeFiles',{operation:'list'});this.rawThemes=Array.isArray(result?.themes)?result.themes:[];this.userThemes=normalizeUserThemes(this.rawThemes);
    if(this.root.querySelector('[data-theme-css]'))this.applyPreferences();
  }
  private async chooseTheme(id:string) {
    if(resolveDocumentTheme(id,this.userThemes).id!==id)throw new Error(this.ui('Theme not found. Refresh the theme list.','테마를 찾을 수 없습니다. 테마 목록을 새로고침하세요.'));
    this.setPreference('documentTheme',id,this.hasDocumentPreferences());this.setPreference('fontFamily','theme',this.hasDocumentPreferences());clearPreviewCache();this.refreshContent();await this.persist();
  }
  private themeDialog() {
    const dialog=modal(this.root,'Themes');dialog.element.classList.add('theme-dialog');
    const note=document.createElement('p');note.textContent=this.ui('Choose a document style. Your Markdown content stays unchanged.','문서의 색과 글꼴을 선택하세요. Markdown 내용은 바뀌지 않습니다.');dialog.body.append(note);
    const list=document.createElement('div');list.className='theme-list';list.setAttribute('role','group');list.setAttribute('aria-label',this.ui('Document themes','문서 테마'));dialog.body.append(list);
    const render=()=>{
      list.replaceChildren();for(const tools of dialog.body.querySelectorAll('.theme-file-tools'))tools.remove();
      for(const theme of [...builtInThemes,...this.userThemes]){const control=button(theme.name);control.dataset.themeOption=theme.id;control.setAttribute('aria-pressed',String(resolveDocumentTheme(this.preferences.documentTheme,this.userThemes).id===theme.id));const label=document.createElement('strong');if(theme.id.startsWith('user:'))label.dataset.userContent='true';label.textContent=theme.name;control.replaceChildren(label);if(theme.description){const description=document.createElement('small');description.textContent=theme.description;control.append(description);}control.addEventListener('click',()=>void this.chooseTheme(theme.id).then(render).catch(error=>this.report(error)));list.append(control);}
      for(const theme of this.userThemes){const tools=document.createElement('div');tools.className='theme-file-tools';const title=document.createElement('span');title.dataset.userContent='true';title.textContent=theme.name;const edit=button('Edit CSS'),remove=button('Delete Theme');edit.addEventListener('click',()=>this.editTheme(theme.id));remove.addEventListener('click',()=>this.deleteTheme(theme.id));tools.append(title,edit,remove);dialog.body.append(tools);}
    };
    render();const importTheme=button('Import CSS Theme…'),create=button('New CSS Theme…'),folder=button('Open Theme Folder'),refresh=button('Refresh Themes');
    importTheme.addEventListener('click',()=>void this.importTheme().catch(error=>this.report(error)));create.addEventListener('click',()=>this.editTheme());folder.addEventListener('click',()=>void this.client.call('themeFiles',{operation:'openFolder'}).catch(error=>this.report(error)));refresh.addEventListener('click',()=>void this.loadThemes().then(render).catch(error=>this.report(error)));dialog.footer.append(importTheme,create,folder,refresh);
  }
  private async importTheme() {
    const before=new Set(this.rawThemes.map(theme=>theme.id)),result:any=await this.client.call('themeFiles',{operation:'import'});if(!result)return;
    await this.loadThemes();const imported=result.theme?.id??this.rawThemes.find(theme=>!before.has(theme.id))?.id;if(imported)await this.chooseTheme('user:'+imported);this.themeDialog();
  }
  private editTheme(id?:string) {
    const existing=this.rawThemes.find(theme=>'user:'+theme.id===id),dialog=modal(this.root,existing?'Edit CSS Theme':'New CSS Theme'),name=input('text',existing?.name??''),css=document.createElement('textarea');css.rows=12;css.value=existing?.css??'#write {\n  font-family: Georgia, serif;\n}\n';name.dataset.themeName='true';css.dataset.themeSource='true';dialog.body.append(field('Theme name',name),field('Stylesheet',css));dialog.element.classList.add('theme-editor');
    const save=button('Save Theme');save.addEventListener('click',()=>{save.disabled=true;void(async()=>{scopeThemeCSS(css.value);const result:any=await this.client.call('themeFiles',{operation:'write',name:name.value,css:css.value,...(existing?{id:existing.id}:{})});await this.loadThemes();const saved=result.theme?.id??existing?.id??this.rawThemes.find(theme=>theme.name===name.value)?.id;if(saved)await this.chooseTheme('user:'+saved);this.themeDialog();})().catch(error=>{save.disabled=false;this.report(error);});});dialog.footer.append(save);
  }
  private deleteTheme(id:string) {
    const theme=this.userThemes.find(theme=>theme.id===id);if(!theme)return;const dialog=modal(this.root,'Delete Theme'),note=document.createElement('p');note.textContent=this.ui(`Delete the managed copy of “${theme.name}”? The original imported file is kept.`,`앱에 보관한 “${theme.name}” 테마를 삭제할까요? 가져오기 전 원본 파일은 유지됩니다.`);dialog.body.append(note);const remove=button('Delete Theme');remove.addEventListener('click',()=>{remove.disabled=true;void(async()=>{await this.client.call('themeFiles',{operation:'remove',id:id.slice(5)});if(this.preferences.documentTheme===id)this.setPreference('documentTheme','default',this.hasDocumentPreferences());await this.loadThemes();await this.persist();this.themeDialog();})().catch(error=>{remove.disabled=false;this.report(error);});});dialog.footer.append(remove);
  }
  private async settingsDialog(category='general') {
    await this.preferenceWrites.catch(()=>{});
    const stored=await this.client.call<{appIcon?:unknown}>('settings',{operation:'read'});
    if(this.disposed)return;
    if(stored && Object.hasOwn(stored,'appIcon')){
      const appIcon=stored.appIcon==='leaf'?'leaf':'ink';
      this.globalPreferences.appIcon=appIcon;this.preferences.appIcon=appIcon;
    }
    const dialog = modal(this.root,'Settings'),targetDoc=this.current(),scope=input('checkbox',String(this.hasDocumentPreferences()));scope.setAttribute('data-document-preference-scope','');scope.disabled=!targetDoc;dialog.body.append(field('Use settings only for this document',scope));
    const scopeNote=document.createElement('p');scopeNote.textContent=this.ui('Document scope applies to document appearance, editing and proofreading. App icon, language and startup behavior apply to the whole app.','문서별 설정은 문서 모양·편집·맞춤법 검사에 적용됩니다. 앱 아이콘·언어·시작 동작은 앱 전체에 적용됩니다.');scopeNote.dataset.scopeNote='true';dialog.body.append(scopeNote);
    const resetDocument=button('Reset Document Settings','reset-document-settings');resetDocument.disabled=!this.hasDocumentPreferences();dialog.footer.append(resetDocument);
    const refreshSettingsScope=()=>{for(const control of dialog.body.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[data-setting]')){const key=control.dataset.setting as keyof Preferences;control.disabled=scope.checked && !documentPreferenceSet.has(key) && key!=='language' && key!=='appIcon';const value=this.preferences[key];if(control instanceof HTMLInputElement && control.type==='checkbox')control.checked=!!value;else if(control instanceof HTMLInputElement && control.type==='radio')control.checked=control.value===value;else control.value=key==='personalDictionary'?this.preferences.personalDictionary.join('\n'):String(value ?? '');}resetDocument.disabled=!this.hasDocumentPreferences(targetDoc);};
    scope.addEventListener('change',()=>{if(targetDoc && this.setDocumentScope(targetDoc,scope.checked)){clearPreviewCache();this.refreshContent();refreshSettingsScope();void this.persist().catch(error=>this.report(error));}});
    resetDocument.addEventListener('click',()=>{if(targetDoc && this.setDocumentScope(targetDoc,false)){scope.checked=false;clearPreviewCache();this.refreshContent();refreshSettingsScope();void this.persist().catch(error=>this.report(error));}});
    const iconGroup=document.createElement('fieldset'),iconLegend=document.createElement('legend'),iconOptions=document.createElement('div');
    iconGroup.className='app-icon-setting';iconLegend.textContent='App icon (all documents)';iconOptions.className='app-icon-options';iconGroup.append(iconLegend,iconOptions);
    for(const [value,name] of [['ink','Black Ink'],['leaf','Green Leaf']] as const){
      const radio=input('radio',value),preview=document.createElement('img'),label=field(name,radio);
      radio.name='app-icon';radio.dataset.setting='appIcon';radio.checked=this.preferences.appIcon===value;
      preview.src=`icons/${value}.png`;preview.alt='';preview.width=48;preview.height=48;label.insertBefore(preview,label.firstChild);
      radio.addEventListener('change',()=>{if(!radio.checked)return;if(this.setPreference('appIcon',radio.value)){refreshSettingsScope();void this.persist().catch(error=>this.report(error));}});
      iconOptions.append(label);
    }
    dialog.body.append(iconGroup);
    const settings: [keyof Preferences,string,HTMLElement][] = [['restoreSession','Reopen documents on startup',input('checkbox',String(this.preferences.restoreSession))],['restoreUnsaved','Keep unsaved drafts when quitting',input('checkbox',String(this.preferences.restoreUnsaved))],['documentTheme','Document theme',select([...builtInThemes,...this.userThemes].map(theme=>[theme.id,theme.name] as [string,string]),this.preferences.documentTheme)],['mode','Editing mode',select([['live','Write'],['source','Markdown Source'],['reading','Preview']],this.preferences.mode)],['grammarCheck','Check grammar and spacing',input('checkbox',String(this.preferences.grammarCheck))],['spellLanguage','Dictionary language',select([['auto','Automatic'],['ko','Korean'],['en','English']],this.preferences.spellLanguage)],['language','App language (all documents)',select([['en','English'],['ko','한국어']],this.preferences.language)],['theme','Appearance',select([['system','System'],['light','Light'],['dark','Dark']],this.preferences.theme)],['fontFamily','Font',select([['theme','Theme font'],['system','System Sans'],['serif','Serif'],['mono','Monospace']],this.preferences.fontFamily)],['fontSize','Text size',input('number',String(this.preferences.fontSize))],['documentWidth','Document width',input('number',String(this.preferences.documentWidth))],['lineHeight','Line height',input('number',String(this.preferences.lineHeight))],['wrap','Wrap source lines',input('checkbox',String(this.preferences.wrap))],['lineNumbers','Source line numbers',input('checkbox',String(this.preferences.lineNumbers))],['focus','Focus current paragraph',input('checkbox',String(this.preferences.focus))],['typewriter','Keep cursor centered',input('checkbox',String(this.preferences.typewriter))],['pandocPath','Free Pandoc executable path (optional)',input('text',this.preferences.pandocPath)],['mathNumbering','Math equation numbering',select([['none','None'],['ams','AMS numbered environments'],['all','All display equations']],this.preferences.mathNumbering)],['mathPhysics','Physics TeX package',input('checkbox',String(this.preferences.mathPhysics))],['imageUploaderPath','Custom image uploader executable (absolute path)',input('text',this.preferences.imageUploaderPath)],['imageUploaderArguments','Uploader argv (JSON string array)',input('text',this.preferences.imageUploaderArguments)]];
    for (const [key,label,control] of settings) { control.dataset.setting = key; if (control instanceof HTMLInputElement && control.type === 'number') { control.min = key === 'fontSize' ? '12' : key === 'documentWidth' ? '480' : '1.2'; control.max = key === 'fontSize' ? '36' : key === 'documentWidth' ? '1400' : '2.5'; control.step = key === 'lineHeight' ? '0.05' : '1'; } control.addEventListener('change',() => { const value = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control instanceof HTMLInputElement && control.type === 'number' ? Number(control.value) : (control as HTMLSelectElement).value; if(key==='imageUploaderArguments'){try{parseUploaderArguments(String(value));}catch(error){control.setAttribute('aria-invalid','true');this.report(error);return;}control.removeAttribute('aria-invalid');} if(!this.setPreference(key,value,scope.checked && key!=='language',targetDoc))return; clearPreviewCache(); if(key==='mathNumbering' || key==='mathPhysics'){if(this.preferences.mode==='live')this.editor.mode('source');this.editor.mode(this.preferences.mode);this.refreshContent();} if(key==='language')organizeSettings(dialog,this.preferences.language);this.refreshContent();void this.persist().catch(error => this.report(error)); }); dialog.body.append(field(label,control)); }
    const css=document.createElement('textarea');css.rows=5;css.value=this.preferences.customCSS;
    const productivity:[keyof ProductivityPreferences,string,HTMLElement][]=[['tabSize','Tab width',input('number',String(this.preferences.tabSize))],['boldMarker','Bold marker',select(['**','__'],this.preferences.boldMarker)],['italicMarker','Italic marker',select(['*','_'],this.preferences.italicMarker)],['bulletMarker','Bullet marker',select(['-','+','*'],this.preferences.bulletMarker)],['pairing','Complete brackets and quotes',input('checkbox',String(this.preferences.pairing))],['defaultCodeLanguage','Default code language',input('text',this.preferences.defaultCodeLanguage)],['rememberCodeLanguage','Remember last code language',input('checkbox',String(this.preferences.rememberCodeLanguage))],['spellcheck','Check spelling while typing',input('checkbox',String(this.preferences.spellcheck))],['emojiCompletion','Complete named emoji',input('checkbox',String(this.preferences.emojiCompletion))],['richPaste','Convert pasted rich text to Markdown',input('checkbox',String(this.preferences.richPaste))],['autoLinks','Automatically link URLs',input('checkbox',String(this.preferences.autoLinks))],['strictSyntax','CommonMark syntax (math stays enabled)',input('checkbox',String(this.preferences.strictSyntax))],['smartPunctuation','Smart punctuation in preview',input('checkbox',String(this.preferences.smartPunctuation))],['renderHTML','Render embedded HTML',input('checkbox',String(this.preferences.renderHTML))],['customCSS','Custom stylesheet',css]];
    productivity.unshift(['autoSave','Automatically save changed files',input('checkbox',String(this.preferences.autoSave))],['watchFiles','Watch files for external changes',input('checkbox',String(this.preferences.watchFiles))]);
    for(const [key,label,control] of productivity){control.dataset.setting=key;if(key==='tabSize'){(control as HTMLInputElement).min='1';(control as HTMLInputElement).max='16';}control.addEventListener('change',()=>{const value=key==='tabSize'?Number((control as HTMLInputElement).value):control instanceof HTMLInputElement && control.type==='checkbox'?control.checked:(control as HTMLTextAreaElement).value;if(!this.setPreference(key,value,scope.checked,targetDoc))return;clearPreviewCache();this.refreshContent();void this.persist().catch(error=>this.report(error));});dialog.body.append(field(label,control));}
    const words=document.createElement('textarea');words.rows=5;words.value=this.preferences.personalDictionary.join('\n');words.dataset.setting='personalDictionary';words.addEventListener('change',()=>{this.setPreference('personalDictionary',words.value.split(/\r?\n/).map(word=>word.trim()).filter(Boolean));void this.persist().catch(error=>this.report(error));});dialog.body.append(field('Personal dictionary',words));
    const proofreadingStatus=document.createElement('p');proofreadingStatus.dataset.proofreadingStatus='true';proofreadingStatus.textContent=this.proofreadingNote||this.ui('Red: spelling. Blue: grammar and spacing. Click an underline or press Option/Alt+Enter for suggestions.','빨간 밑줄은 맞춤법, 파란 밑줄은 문법·띄어쓰기 교정 후보입니다. 밑줄을 누르거나 Option/Alt+Enter로 교정안을 볼 수 있습니다.');dialog.body.append(proofreadingStatus);
    const themes=button('Manage Themes…');themes.addEventListener('click',()=>this.themeDialog());dialog.footer.append(themes);
    const reset=button('Reset Settings','reset-settings');reset.addEventListener('click',()=>{this.syncGlobalPreferences();this.globalPreferences={...defaults,documentOverrides:{...this.globalPreferences.documentOverrides},session:normalizeSession(this.preferences.session),recentFiles:[...this.preferences.recentFiles],personalDictionary:[...this.preferences.personalDictionary],recentFolders:[...this.preferences.recentFolders],pinnedFolders:[...this.preferences.pinnedFolders],exportPresets:{...this.preferences.exportPresets}};this.preferences=this.preferencesFor();this.applyPreferences();clearPreviewCache();void this.persist(true).catch(error=>this.report(error));dialog.close();});dialog.footer.append(reset);
    const uploaderNote=document.createElement('p');uploaderNote.dataset.uploaderNote='true';uploaderNote.textContent='The uploader receives each distinct local image path as a separate argument after your argv. Return a JSON URL array, {"urls":[…]}, or one HTTP(S) URL per line in the same order. A failed or partial upload leaves source links unchanged.';dialog.body.append(uploaderNote);
    const finalNewline = input('checkbox',/(?:\r\n|\n|\r)$/.test(this.editor.text()) ? 'true' : 'false'); finalNewline.dataset.finalNewline='true';finalNewline.addEventListener('change',() => { const text = this.editor.text(), ending = this.current()?.lineEnding === 'CRLF' ? '\r\n' : '\n'; this.editor.replace(finalNewline.checked ? text.replace(/(?:\r\n|\n|\r)*$/,'') + ending : text.replace(/(?:\r\n|\n|\r)+$/,'')); }); dialog.body.append(field('Document final newline',finalNewline));refreshSettingsScope();
    const done=button('Done');done.addEventListener('click',()=>dialog.close());dialog.footer.append(done);const languageControl=dialog.body.querySelector<HTMLInputElement>('[data-setting="language"]');if(languageControl)languageControl.disabled=false;organizeSettings(dialog,this.preferences.language,category);
  }
  private async recoveryDialog() {
    const dialog = modal(this.root,'Recover Unsaved Documents'); if (!this.recoveries.length) { dialog.body.textContent = 'No recovery snapshots were found. Inkleaf checkpoints changes while you edit.'; return; }
    for (const recovery of this.recoveries) { const snapshot = recovery.snapshot ?? recovery, control = button(snapshot.path ? basename(snapshot.path) : this.ui('Unsaved document','임시 문서'));control.dataset.userContent='true'; control.addEventListener('click',() => { void this.client.call('restoreDocument',{documentId:snapshot.documentId}).then(value => { this.adopt(normalizeSnapshot(value),true); dialog.close(); this.status('Recovery opened. Save to write the original file.'); }).catch(error => this.report(error)); }); dialog.body.append(control); }
  }
  private async runCommand(command: EditorCommand) {
    if (!this.current()) throw new Error('Create or open a document first.'); if (this.preferences.mode === 'reading') this.setMode('live'); let value = command.value; const origin=this.mutationOrigin();
    if (command.type === 'link' || command.type === 'image' || command.type === 'linkReference') { if (value === undefined) value = await promptValue(this.root,command.type === 'image' ? 'Insert Image URL' : command.type === 'linkReference' ? 'Insert Reference Link' : 'Insert Link','URL'); if (value === null) return; }
    if (command.type === 'codeBlock' && value === undefined) { value = await promptValue(this.root,'Code Block','Language (optional)',this.preferences.defaultCodeLanguage||(this.preferences.rememberCodeLanguage?this.preferences.lastCodeLanguage:'')); if (value === null) return; }
    if (command.type === 'alert') value = String(value ?? 'note').toLowerCase();
    if (command.type === 'heading' && value === 0) { const source = this.editor.text(), selection = this.editor.selection(), lines = sourceLines(source), first = lineAt(lines,selection.from), last = lineAt(lines,selection.to > selection.from ? selection.to - 1 : selection.to); let result = source, from = selection.from, to = selection.to; for (let i = last; i >= first; i--) { const match = /^ {0,3}#{1,6}[ \t]+/.exec(lines[i].text); if (!match) continue; const start = lines[i].from; result = result.slice(0,start) + result.slice(start + match[0].length); from = from > start ? Math.max(start,from - match[0].length) : from; to = to > start ? Math.max(start,to - match[0].length) : to; } this.editor.replace(result,{from,to}); return; }
    this.requireOrigin(origin);if(command.type==='codeBlock' && this.preferences.rememberCodeLanguage){this.setPreference('lastCodeLanguage',String(value??''),this.hasDocumentPreferences(),this.current(),false);void this.persist().catch(error=>this.report(error));} this.editor.command({...command,value}); this.refreshContent();
  }
  private async nativeCommand(command: EditorCommand) {
    if(command.type==='host-error'){this.report(new Error(String(command.value??'Window state could not be saved.')));return;}
    if (!command || typeof command.type !== 'string') throw new Error('Invalid native command.');
    const aliases: Record<string,string> = {openFolder:'folder',saveAs:'save-as',insertImage:'insert-image',pastePlain:'paste-plain',copyMarkdown:'copy-markdown',copyPlain:'copy-plain',copyHTML:'copy-html',searchWorkspace:'workspace-search',replace:'find',quickOpen:'quick-open',reading:'reading',live:'live'};
    if (command.type === 'openDocument') { await this.openPath(String(command.value)); return; }
    if (command.type === 'export') { await this.export(String(command.value)); return; }
    if (command.type === 'language') { this.setPreference('language',command.value);this.refresh();const dialog=this.root.querySelector('dialog');if(dialog?.classList.contains('settings-dialog'))await this.settingsDialog();await this.persist();return; }
    if (command.type === 'documentTheme') { await this.chooseTheme(String(command.value));return; }
    if (command.type === 'theme') { this.preferences.theme = String(command.value); this.applyPreferences(); await this.persist(); return; }
    if (command.type.startsWith('zoom')) { this.setPreference('fontSize',command.type==='zoomReset'?18:Math.max(12,Math.min(36,this.preferences.fontSize+(command.type==='zoomIn'?1:-1))),this.hasDocumentPreferences()); this.applyPreferences(); await this.persist(); return; }
    if (COMMANDS.some(entry => entry.type === command.type)) { await this.runCommand(command); return; } await this.action(aliases[command.type] ?? command.type);
  }
  async action(action: string): Promise<void> {
    switch (action) {
      case 'check-files': await this.checkExternalFiles();break;
      case 'new': {const empty=!this.documents.size;if(empty)this.editor.setLocked(true);try{this.adopt(normalizeSnapshot(await this.client.call('createDocument')));}finally{if(empty)this.editor.setLocked(!this.documents.size);}break;}
      case 'open': { const value = await this.client.call('chooseDocument'); if (value) { this.adopt(normalizeSnapshot(value)); this.status(''); } break; }
      case 'folder': await this.chooseFolder(); break;
      case 'pin-folder': {if(!this.workspace)throw new Error('Choose a folder first.');this.preferences.pinnedFolders=this.preferences.pinnedFolders.includes(this.workspace)?this.preferences.pinnedFolders.filter(path=>path!==this.workspace):recordRecent(this.preferences.pinnedFolders,this.workspace);this.refreshFileControls();await this.persist();break;}
      case 'save': await this.save(); break;
      case 'save-as': await this.save(true); break;
      case 'duplicate': this.adopt(normalizeSnapshot(await this.client.call('createDocument',{text:this.editor.text()}))); break;
      case 'autoindent-selected': case 'autoindent-all': if(this.preferences.mode==='reading')this.setMode('source');this.editor.autoIndent(action==='autoindent-all');break;
      case 'copy-code': {const source=this.editor.text(),selection=this.editor.selection();let found:string|undefined;markdownParser.parse(source).iterate({enter(node){if(node.name==='FencedCode' && node.from<=selection.from && node.to>=selection.to){const marks=node.node.getChildren('CodeMark'),lines=sourceLines(source),start=lines[lineAt(lines,marks[0]?.from??node.from)].end,end=marks.length>1?lines[lineAt(lines,marks.at(-1)!.from)].from:node.to;found=source.slice(start,end);return false;}}});if(found===undefined)throw new Error('Place the cursor in one code block first.');await this.client.call('clipboard',{operation:'write',text:found});this.status('Code copied.');break;}
      case 'undo': case 'redo': this.historyAction(action); break;
      case 'sidebar': { const sidebar = this.query('.sidebar'); sidebar.hidden = !sidebar.hidden; this.query('[data-action="sidebar"]').setAttribute('aria-expanded',String(!sidebar.hidden)); break; }
      case 'files': this.showPanel('files'); break;
      case 'outline': this.showPanel('outline'); this.refreshContent(); break;
      case 'find': this.invalidateSearch();this.searchMode = 'document'; this.showPanel('search'); this.updateSearch(); this.query('[data-control="find"]').focus(); break;
      case 'next-match': this.nextMatch(1); break;
      case 'previous-match': this.nextMatch(-1); break;
      case 'replace-one': this.replaceSearch(false); break;
      case 'replace-all': this.replaceSearch(true); break;
      case 'workspace-search': await this.workspaceSearch(); break;
      case 'quick-open': await this.quickOpen(); break;
      case 'settings': await this.settingsDialog(); break;
      case 'themes': this.themeDialog(); break;
      case 'import-theme': await this.importTheme(); break;
      case 'theme-folder': await this.client.call('themeFiles',{operation:'openFolder'});break;
      case 'proofreading-settings': await this.settingsDialog('proofreading');break;
      case 'spellcheck': this.setPreference('spellcheck',!this.preferences.spellcheck,this.hasDocumentPreferences());await this.persist();break;
      case 'dictionary': this.dictionaryDialog();break;
      case 'statistics': {const popover=this.query<HTMLDetailsElement>('.document-info');popover.open=!popover.open;break;}
      case 'save-all': for(const doc of this.documents.values())if(this.isDirty(doc))await this.saveRecord(doc);break;
      case 'close-document': if(this.current())await this.closeDocument(this.current()!);break;
      case 'close-all': {let complete=true;for(const doc of [...this.documents.values()])if(!(await this.closeDocument(doc,false))){complete=false;break;}if(complete&&!this.documents.size)await this.action('new');break;}
      case 'reopen-closed': {const closed=this.closedDocuments.at(-1);if(!closed)break;if(closed.keptDraft){this.adopt(normalizeSnapshot(await this.client.call('restoreDocument',{documentId:closed.documentId})),true);this.recoveries=this.recoveries.filter(recovery=>(recovery.snapshot??recovery).documentId!==closed.documentId);}else if(closed.path)await this.openPath(closed.path);else this.adopt(normalizeSnapshot(await this.client.call('createDocument',{text:closed.text})));this.closedDocuments.pop();break;}
      case 'document-files': this.documentFileTools();break;
      case 'table': { const doc = this.current(); if (!doc) throw new Error('Open a document first.'); const revision = doc.revision; tableDialog(this.root,this.editor,() => this.activeId === doc.documentId && doc.revision === revision,error => this.report(error)); break; }
      case 'focus': case 'typewriter': this.setPreference(action,!this.preferences[action],this.hasDocumentPreferences()); this.applyPreferences(); await this.persist(); break;
      case 'source': this.setMode(this.preferences.mode === 'source' ? 'live' : 'source'); this.editor.view.focus(); break;
      case 'live': case 'reading': this.setMode(action); break;
      case 'copy-markdown': case 'copy-plain': case 'copy-html': await this.copy(action); break;
      case 'paste-rich': await this.pasteClipboard(false);break;
      case 'paste-image': await this.pasteClipboard(true);break;
      case 'paste-plain': { const origin=this.mutationOrigin(); const value: any = await this.client.call('clipboard',{operation:'read'}); if (typeof value?.text !== 'string') throw new Error('The clipboard contains no plain text.'); this.requireOrigin(origin); const selection = origin.selection, text = origin.source; this.editor.replace(text.slice(0,selection.from) + value.text + text.slice(selection.to),{from:selection.from + value.text.length,to:selection.from + value.text.length}); break; }
      case 'insert-image': await this.insertImages(); break;
      case 'upload-images': case 'upload-selected-image': await this.uploadLocalImages(action==='upload-selected-image');break;
      case 'resolve-image-references': {const source=this.editor.text(),resolved=resolveImageReferences(source);this.editor.replace(resolved);this.status(source===resolved?'No resolvable reference images found.':'Reference images converted to inline URLs. Other links and definitions are preserved.');break;}
      case 'images-to-html': case 'images-to-markdown': {
        if(!this.current())throw new Error('Open a document first.');
        this.editor.replace(convertImageSyntax(this.editor.text(),action==='images-to-html'?'html':'markdown'));break;
      }
      case 'relative-image-urls': {
        const doc=this.current();if(!doc)throw new Error('Open a document first.');const root=this.assetRoots.get(doc.documentId) ?? (doc.path?parentPath(doc.path):undefined);
        if(!root)throw new Error('Save the document or import an image first.');this.editor.replace(relativeImageURLs(this.editor.text(),root));break;
      }
      case 'image-properties': {const origin=this.mutationOrigin(),doc=this.current()!;openImageDialog(this.root,{source:origin.source,selection:origin.selection,isCurrent:()=>this.originCurrent(origin),apply:(text,selection)=>{this.requireOrigin(origin);this.editor.replace(text,selection);},assetRoot:this.assetRoots.get(doc.documentId)??(doc.path?parentPath(doc.path):undefined),readAsset:(path,root)=>this.client.call('readAsset',{path,root})});break;}
      case 'rename-image': case 'move-image': case 'delete-image': case 'copy-images': case 'move-images': this.imageFileDialog(action);break;
      case 'reload-images': {
        if(!this.current())throw new Error('Open a document first.');clearPreviewCache();const mode=this.preferences.mode;if(mode==='live')this.editor.mode('source');this.editor.mode(mode);
        if(this.preferences.mode==='reading')this.renderReading();
        this.status('Images reloaded.');break;
      }
      case 'recoveries': await this.recoveryDialog(); break;
      case 'import': { const value = await this.client.call('importDocument'); if (value) {const snapshot=normalizeSnapshot(value);if(!snapshot.path&&this.unsavedAssetRoot)this.assetRoots.set(snapshot.documentId,this.unsavedAssetRoot);this.adopt(snapshot);} break; }
      case 'export-options': this.exportDialog(); break;
      case 'copy-math-tex': case 'copy-math-mathml': case 'copy-math-svg': case 'save-math-tex': case 'save-math-mathml': case 'save-math-svg': case 'copy-diagram-svg': case 'save-diagram-svg': await this.mediaAction(action);break;
      case 'repeat-export': {const previous=this.lastExports.get(this.activeId);if(!previous)throw new Error('Export this document once before repeating its export.');await this.export(previous.format,{...previous.options,destination:previous.destination});break;}
      case 'print': { const doc = this.current(); if (!doc) throw new Error('Open a document first.'); const content = await this.preparedHTML({...doc},this.exportOptions); await this.client.call('print',{content,options:this.exportOptions,documentPath:doc.path}); break; }
      case 'run-tool': this.toolDialog(); break;
      case 'cancel-job': {
        const jobId=this.exportJob || this.toolJob || this.searchJob;if(!jobId)break;
        const result:any=await this.client.call('cancelTool',{jobId});
        if(result?.outputCreated===true && this.exportJob===jobId)this.committedExportJobs.add(jobId);
        if(result?.cancelled===true) {
          if(this.exportJob===jobId)this.exportJob='';if(this.toolJob===jobId)this.toolJob='';if(this.searchJob===jobId)this.searchJob='';
          this.status(result?.outputCreated===true?`Output was already created at ${result.path ?? 'the chosen destination'}. Post-command cancellation was acknowledged.`:'Cancellation acknowledged.');
        } else this.status(result?.outputCreated===true?`Output was already created at ${result.path ?? 'the chosen destination'}. The post-command has finished or could not be stopped.`:'The operation has already finished or could not be cancelled.');
        this.query('[data-action="cancel-job"]').hidden=!(this.exportJob || this.toolJob || this.searchJob);break;
      }
      case 'dismiss-message': this.status(''); break;
      case 'retry': await this.start(); break;
      default: throw new Error(`Unsupported command: ${action}`);
    }
  }
  private selectedText() { const selection = this.editor.selection(), text = this.editor.text(); return selection.from === selection.to ? text : text.slice(selection.from,selection.to); }
  private insertAtOrigin(origin:MutationOrigin,text:string){
    this.requireOrigin(origin);const eol=this.current()?.lineEnding==='CRLF'?'\r\n':'\n';text=text.replace(/\r\n|\r|\n/g,eol);
    this.editor.replace(origin.source.slice(0,origin.selection.from)+text+origin.source.slice(origin.selection.to),{from:origin.selection.from+text.length,to:origin.selection.from+text.length});
  }
  private receivePaste(event:ClipboardEvent):boolean{
    if(this.preferences.mode==='reading')return false;
    const images=Array.from(event.clipboardData?.files??[]).filter(file=>file.type.startsWith('image/'));
    if(images.length){const origin=this.mutationOrigin();void this.importImageFiles(images,origin).catch(error=>this.report(error));return true;}
    const html=event.clipboardData?.getData('text/html');
    if(html && this.preferences.richPaste){try{this.insertAtOrigin(this.mutationOrigin(),htmlToMarkdown(html));}catch(error){this.report(error);}return true;}
    return false;
  }
  private receiveDrop(event:DragEvent):boolean{
    const files=Array.from(event.dataTransfer?.files??[]).filter(file=>file.type.startsWith('image/'));
    if(!files.length || this.preferences.mode==='reading')return false;
    const origin=this.mutationOrigin();void this.importImageFiles(files,origin).catch(error=>this.report(error));return true;
  }
  private async importImageFiles(files:File[],origin:MutationOrigin){
    const imported:string[]=[];
    for(const file of files){this.requireOrigin(origin);const bytes=new Uint8Array(await file.arrayBuffer()),base64=window.btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
      imported.push(...await this.importImageData(origin,base64,file.name));}
    this.insertAtOrigin(origin,imported.join('\n'));
  }
  private async importImageData(origin:MutationOrigin,base64:string,filename:string):Promise<string[]>{
    this.requireOrigin(origin);const result:any=await this.client.call('importImages',{documentPath:origin.path,base64,filename,directory:'assets'});this.requireOrigin(origin);
    const images=Array.isArray(result)?result:result?.paths??[],root=origin.path?parentPath(origin.path):this.unsavedAssetRoot;
    if(root)this.assetRoots.set(origin.documentId,root);
    return images.map((image:any)=>{const path=typeof image==='string'?image:image.path;if(typeof path!=='string')throw new Error('Image import returned no path.');const url=root?imageURLForPath(path,root):path.split('/').map(encodeURIComponent).join('/');return `![](${url})`;});
  }
  private async pasteClipboard(imageOnly:boolean){
    const origin=this.mutationOrigin(),value:any=await this.client.call('clipboard',{operation:'read'});this.requireOrigin(origin);
    if(value?.base64){const extension=value.type==='image/tiff'?'tiff':'png';this.insertAtOrigin(origin,(await this.importImageData(origin,value.base64,`Pasted Image.${extension}`)).join('\n'));}
    else if(imageOnly)throw new Error('The clipboard contains no image.');
    else if(value?.html)this.insertAtOrigin(origin,htmlToMarkdown(value.html));
    else if(typeof value?.text==='string')this.insertAtOrigin(origin,value.text);
    else throw new Error('The clipboard contains no text or image.');
  }
  private async copy(action: string) {
    const text = this.selectedText(); if (action === 'copy-markdown') await this.client.call('clipboard',{operation:'write',text}); else { const element = document.createElement('article'); element.innerHTML = renderMarkdown(text); if (action === 'copy-html') { await this.preview(element); await this.client.call('clipboard',{operation:'write',text,html:element.innerHTML}); } else await this.client.call('clipboard',{operation:'write',text:element.textContent ?? stripFormat(text)}); } this.status('Copied to the clipboard.');
  }
  private selectedMedia(source:string,selection:{from:number;to:number},diagram=false) {
    const excluded:{from:number;to:number}[]=[];
    markdownParser.parse(source).iterate({enter(node){if(['InlineCode','FencedCode','CodeBlock','HTMLBlock','HTMLTag','URL','Image'].includes(node.name)){excluded.push({from:node.from,to:node.to});return false;}}});
    const inline:{from:number;to:number;tex:string}[]=[];
    const hidden=(position:number)=>excluded.some(range=>range.from<=position && position<range.to);
    for(let from=0;from<source.length;from++){
      if(source[from]!=='$' || source[from+1]==='$' || source[from-1]==='$' || /\s/.test(source[from+1]??'') || hidden(from))continue;
      let slashes=0;for(let before=from-1;before>=0 && source[before]==='\\';before--)slashes++;if(slashes%2)continue;
      let to=from+1;while((to=source.indexOf('$',to))>=0){if(source[to-1]==='\\'){to++;continue;}break;}
      if(to<=from+1 || /\s/.test(source[to-1]) || hidden(to))continue;
      inline.push({from,to:to+1,tex:source.slice(from+1,to).replace(/\r\n|\r/g,'\n')});from=to;
    }
    const candidates:{from:number;to:number;tex:string;display:boolean;mathIndex:number;sourceOffset:number;html:string}[]=[];let mathIndex=0,inlineCursor=0;
    for(const block of markdownBlocks(source)){
      const element=document.createElement('div');element.innerHTML=block.html;
      for(const node of element.querySelectorAll<HTMLElement>('[data-math],[data-diagram]')){
        if(node.dataset.diagram){if(diagram)candidates.push({from:block.from,to:block.to,tex:node.textContent??'',display:true,mathIndex:-1,sourceOffset:block.from,html:node.outerHTML});continue;}
        const index=mathIndex++;if(diagram)continue;const tex=node.textContent??'',display=node.dataset.math==='block';
        if(display)candidates.push({from:block.from,to:block.to,tex,display,mathIndex:index,sourceOffset:block.from,html:node.outerHTML});
        else {const found=inline.findIndex((range,i)=>i>=inlineCursor && range.from>=block.from && range.to<=block.to && range.tex===tex);if(found>=0){inlineCursor=found+1;candidates.push({...inline[found],display,mathIndex:index,sourceOffset:block.from,html:node.outerHTML});}}
      }
    }
    const chosen=candidates.filter(range=>selection.from===selection.to?range.from<=selection.from && selection.from<range.to:range.from<selection.to && range.to>selection.from);
    if(chosen.length!==1)throw new Error(diagram?'Select exactly one rendered diagram block.':'Select exactly one math formula outside code examples.');return chosen[0];
  }
  private async mediaAction(action:string) {
    const origin=this.mutationOrigin(),doc={...this.current()!},diagram=action.includes('diagram'),selected=this.selectedMedia(origin.source,origin.selection,diagram),format=action.endsWith('-tex')?'tex':action.endsWith('-mathml')?'mathml':'svg';
    let content=selected.tex;
    if(diagram){const element=document.createElement('div');element.innerHTML=selected.html;await typesetPreviews(element,this.previewOptions(doc));const svg=element.querySelector('svg');if(!svg || element.querySelector('.preview-error'))throw new Error(`The selected diagram could not be rendered for SVG export: ${element.querySelector('.preview-error')?.textContent ?? 'No SVG was produced.'}`);content=svg.outerHTML;}
    else if(format!=='tex')content=await convertMath(selected.tex,format,{...this.previewOptions(doc),display:selected.display,sourceOffset:selected.sourceOffset,mathIndex:selected.mathIndex});
    this.requireOrigin(origin);
    if(action.startsWith('copy-')){
      const args:Record<string,unknown>={operation:'write',text:content};
      if(format==='mathml'||format==='svg')args.html=content;
      if(format==='svg'){args.type='image/svg+xml';args.base64=window.btoa([...new TextEncoder().encode(content)].map(byte=>String.fromCharCode(byte)).join(''));}
      await this.client.call('clipboard',args);this.status(`Selected ${diagram?'diagram':'math'} copied as ${format.toUpperCase()}.`);
    } else {const result:any=await this.client.call('export',{assetKind:format,format,content,filename:`${diagram?'Diagram':'Equation'}.${format}`,documentPath:origin.path,options:{}});this.status(result?.path?`Saved selected ${diagram?'diagram':'math'} to ${result.path}`:'Selected media saved.');}
  }
  private imageFileDialog(action:string) {
    const origin=this.mutationOrigin(),doc=this.current()!,root=this.assetRoots.get(doc.documentId) ?? (doc.path?parentPath(doc.path):undefined);
    if(!root)throw new Error('Save this document or import a local image first.');
    const operation:ImageFileOperation=action==='rename-image'?'rename':action==='delete-image'?'trash':action==='copy-images'?'copy':'move';
    const selection=action.endsWith('-image')?origin.selection:undefined,chosen=localImagePlan(origin.source,root,selection);
    if(!chosen.paths.length || (selection && chosen.paths.length!==1))throw new Error('Select one local image, or choose a bulk image action.');
    const title=operation==='trash'?'Delete Image File':operation==='rename'?'Rename Image File':operation==='copy'?'Copy All Local Images':selection?'Move Image File':'Move All Local Images';
    const dialog=modal(this.root,title),destination=input('text',operation==='rename'?basename(chosen.paths[0]):`${root}/assets`);destination.dataset.imageDestination='true';
    const note=document.createElement('p');note.textContent=operation==='trash'?'This moves the selected image file to macOS Trash and removes all image references to it from this document. Confirm only if you intend to change the original file.':operation==='copy'?'Copies the listed files and updates their image links. Originals remain in place. Existing destination files will never be overwritten.':'Moves the listed original files and updates all image links to them in this document. Existing destination files will never be overwritten.';
    const paths=document.createElement('pre');paths.textContent=chosen.paths.join('\n');dialog.body.append(note,paths);
    if(operation!=='trash')dialog.body.append(field(operation==='rename'?'New filename':'Existing destination folder inside the image root',destination));
    const historyNote=document.createElement('p');historyNote.textContent='Undo restores Markdown links only. It does not undo filesystem changes; deleted files can be restored from macOS Trash.';dialog.body.append(historyNote);
    const apply=button(operation==='trash'?'Move Image to Trash':'Apply Image File Changes','image-file-apply');apply.addEventListener('click',()=>{
      apply.disabled=true;void(async()=>{
        this.requireOrigin(origin);
        if(operation==='rename' && (!destination.value || /[\/\\]/.test(destination.value) || ['.','..'].includes(destination.value)))throw new Error('Enter a filename without directory separators.');
        const target=operation==='trash'?undefined:operation==='rename'?`${parentPath(chosen.paths[0])}/${destination.value}`:destination.value;
        planImageFileOperation(origin.source,root,operation,target,selection);
        const text=await manageImageFiles({source:origin.source,root,operation,destination:target,selection,isCurrent:()=>this.originCurrent(origin),call:(method,args)=>this.client.call(method,args)});
        this.requireOrigin(origin);this.editor.replace(text);dialog.close();clearPreviewCache();this.refreshContent();this.status('Image files and links updated.');
      })().catch(error=>{apply.disabled=false;this.report(error);});
    });dialog.footer.append(apply);
  }
  private async uploadLocalImages(selected=false) {
    if(this.toolJob)throw new Error('A tool or image upload is already running.');
    const origin=this.mutationOrigin(),doc=this.current()!,root=this.assetRoots.get(doc.documentId) ?? (doc.path?parentPath(doc.path):undefined),jobId=`image-upload-${Date.now()}`;
    this.toolJob=jobId;this.status('Uploading local images…');this.query('[data-action="cancel-job"]').hidden=false;
    try {
      const text=await uploadImages({source:origin.source,root,selection:selected?origin.selection:undefined,executable:this.preferences.imageUploaderPath,argumentsJSON:this.preferences.imageUploaderArguments,jobId,isCurrent:()=>this.originCurrent(origin),run:args=>this.client.call('runTool',args as unknown as Record<string,unknown>)});
      this.requireOrigin(origin);this.editor.replace(text);this.status('Image URLs updated.');
    } finally {if(this.toolJob===jobId)this.toolJob='';if(!this.disposed)this.query('[data-action="cancel-job"]').hidden=!(this.toolJob || this.exportJob || this.searchJob);}
  }
  private async insertImages() {
    const origin=this.mutationOrigin(),doc=this.current()!; const result: any = await this.client.call('importImages',{documentPath:doc.path,directory:'assets'}); const images = Array.isArray(result) ? result : result?.paths ?? [];
    this.requireOrigin(origin); const selection = origin.selection, source = origin.source; const root = doc.path ? parentPath(doc.path) : images[0] ? parentPath(parentPath(typeof images[0] === 'string' ? images[0] : images[0].path)) : '';
    if (root) this.assetRoots.set(doc.documentId,root); const markdown = images.map((image: any) => { const path = typeof image === 'string' ? image : image.path; const url=root?imageURLForPath(path,root):path.split('/').map(encodeURIComponent).join('/'); return `![](${url})`; }).join('\n');
    if (markdown) this.editor.replace(source.slice(0,selection.from) + markdown + source.slice(selection.to),{from:selection.from,to:selection.from + markdown.length});
  }
  private external(url: string) { if (url.startsWith('#')) { const heading = getOutline(this.editor.text()).find(entry => entry.id === url.slice(1)); if (heading) this.editor.select(heading); return; } void this.client.call('openExternal',{url}).catch(error => this.report(error)); }
  private previewOptions(doc?:NativeSnapshot) {const preferences=this.preferencesFor(doc);return {dark:this.root.dataset.theme==='dark',documentId:doc?.documentId,documentSource:doc?.text,numbering:preferences.mathNumbering,physics:preferences.mathPhysics};}
  private async preview(element: HTMLElement, doc: NativeSnapshot | undefined = this.current()): Promise<void> {
    const snapshot=doc?{...doc}:undefined,options=this.previewOptions(snapshot);
    if(snapshot)await this.resolveImages(element,snapshot);await typesetPreviews(element,options);
  }
  private async resolveImages(element: HTMLElement, doc: NativeSnapshot) {
    const root = this.assetRoots.get(doc.documentId) ?? (doc.path ? parentPath(doc.path) : undefined); if (!root) return;
    await Promise.all([...element.querySelectorAll<HTMLImageElement>('img')].map(async image => {
      const source = image.getAttribute('src') ?? ''; if (!source || /^(?:data:|https?:|blob:)/i.test(source)) return;
      try { const path = localImagePath(source,root); const asset: any = await this.client.call('readAsset',{path,root}); image.src = `data:${asset.type || 'application/octet-stream'};base64,${asset.base64}`; image.dataset.assetPath = path; }
      catch (error) { image.alt = `${image.alt || basename(source)} (image unavailable)`; const note = document.createElement('span'); note.className = 'preview-error'; note.textContent = error instanceof Error ? error.message : String(error); image.after(note); }
    }));
  }
  private async preparedHTML(doc: NativeSnapshot, options: any): Promise<string> {
    const preferences=this.preferencesFor(doc),theme=resolveDocumentTheme(preferences.documentTheme,this.userThemes),css=options.useDocumentTheme===false?'':themeExportCSS(theme),element=document.createElement('article');let rendered:string;
    configureMarkdown(preferences);try{rendered=renderMarkdown(doc.text);}finally{configureMarkdown(this.preferences);}
    element.innerHTML=rendered;await this.preview(element,doc);
    configureMarkdown(preferences);try{return exportHTML(doc.text,{...options,css,dark:options.dark===true||(options.useDocumentTheme!==false&&theme.appearance==='dark')}).replace(`<article>${rendered}</article>`,`<article>${element.innerHTML}</article>`);}finally{configureMarkdown(this.preferences);}
  }
  async export(format: string, options = this.exportOptions): Promise<void> {
    const current = this.current(); if (!current) throw new Error('Create or open a document first.'); if (this.exportJob) throw new Error('An export is already running. Cancel it or wait for completion.');
    this.validateExportOptions(options);const snapshot = {...current}, immutableOptions = {...options,extraArguments:[...(options.extraArguments ?? [])],postArguments:[...(options.postArguments ?? [])]}, jobId = `export-${Date.now()}`; for(const key of ['template','referenceDoc','css','postCommand'])if(typeof immutableOptions[key]==='string' && !immutableOptions[key].trim())delete immutableOptions[key]; this.exportJob = jobId; this.status(`Preparing ${format.toUpperCase()} export…`); this.query('[data-action="cancel-job"]').hidden = false;
    try {
      const htmlFormats = ['html','htm','pdf','png','jpeg','jpg','svg']; let content = htmlFormats.includes(format) ? await this.preparedHTML(snapshot,{...immutableOptions,css:''}) : ['txt','text'].includes(format) ? stripFormat(snapshot.text) : snapshot.text;

      if (this.exportJob !== jobId) return; const result: any = await this.client.call('export',{format,content,filename:exportFilename(snapshot.path,snapshot.text,format),options:{...immutableOptions,toc:!!immutableOptions.outline},documentPath:snapshot.path,jobId}); if(this.exportJob===jobId || this.committedExportJobs.delete(jobId)){
        if(typeof result?.path==='string'){const {destination,...savedOptions}=immutableOptions;this.lastExports.set(snapshot.documentId,{format,options:savedOptions,destination:result.path});const repeat=this.root.querySelector<HTMLButtonElement>('[data-action="repeat-export"]');if(repeat)repeat.disabled=!this.lastExports.has(this.activeId);}
        this.status((result?.path?`Exported to ${result.path}`:'Export completed.')+(typeof result?.diagnostics==='string' && result.diagnostics.trim()?`\n${result.diagnostics.trim()}`:''));
      }
    } finally {this.committedExportJobs.delete(jobId); if (this.exportJob === jobId) this.exportJob = ''; if (!this.disposed) this.query('[data-action="cancel-job"]').hidden = !(this.exportJob || this.toolJob || this.searchJob); }
  }
  private validateExportOptions(options:any) {
    for(const key of ['extraArguments','postArguments'])if(options[key]!==undefined && (!Array.isArray(options[key]) || options[key].some((value:unknown)=>typeof value!=='string' || value.includes('\0'))))throw new Error(`${key} must be a string array without NUL.`);
    if(options.tocDepth!==undefined && (!Number.isInteger(options.tocDepth) || options.tocDepth<1 || options.tocDepth>6))throw new Error('Contents depth must be an integer from 1 to 6.');
    if(options.postCommand && (typeof options.postCommand!=='string' || !options.postCommand.startsWith('/') || options.postCommand.includes('\0')))throw new Error('Post-export executable must be an absolute path without NUL.');
  }
  private exportDialog(selectedPreset='') {
    const dialog=modal(this.root,'Export Document'),formats=[['html','HTML'],['pdf','PDF'],['png','PNG'],['jpeg','JPEG'],['svg','SVG'],['md','Markdown'],['txt','Plain Text'],['docx','Word (Pandoc)'],['odt','OpenDocument (Pandoc)'],['rtf','RTF (Pandoc)'],['epub','EPUB (Pandoc)'],['latex','LaTeX (Pandoc)'],['rst','reStructuredText (Pandoc)'],['textile','Textile (Pandoc)'],['opml','OPML (Pandoc)'],['mediawiki','MediaWiki (Pandoc)'],['gfm','GFM (Pandoc)'],['commonmark','CommonMark (Pandoc)']] as [string,string][];
    const format=select(formats,'html');format.dataset.exportFormat='true';dialog.body.append(field('Format',format));
    const preset=select([['','Current options'],...Object.keys(this.preferences.exportPresets ?? {}).map(name=>[name,name] as [string,string])],selectedPreset);preset.dataset.exportPreset='true';dialog.body.append(field('Preset',preset));
    const fields=document.createElement('div');fields.className='export-fields';dialog.body.append(fields);
    const exportButton=button('Export','export-apply'),rename=button('Rename Preset','rename-export-preset'),remove=button('Delete Preset','delete-export-preset');
    const arrayInput=(value:unknown)=>{const control=document.createElement('textarea');control.rows=2;control.value=JSON.stringify(value ?? []);return control;};
    const render=()=>{
      fields.replaceChildren();const pandoc=!['html','pdf','png','jpeg','svg','md','txt'].includes(format.value);
      const definitions:[string,string,HTMLElement][]=[['title','Title',input('text',this.exportOptions.title ?? '')],['author','Author',input('text',this.exportOptions.author ?? '')],['outline','Include contents',input('checkbox',String(!!this.exportOptions.outline))],['useDocumentTheme','Use selected document theme',input('checkbox',String(this.exportOptions.useDocumentTheme!==false))],['dark','Dark export background',input('checkbox',String(this.exportOptions.dark===true))]];
      if(pandoc)definitions.push(['template','Pandoc template path',input('text',this.exportOptions.template ?? '')],['referenceDoc','Pandoc reference document path',input('text',this.exportOptions.referenceDoc ?? '')],['css','Pandoc CSS file path',input('text',this.exportOptions.css ?? '')],['extraArguments','Additional Pandoc argv (JSON string array)',arrayInput(this.exportOptions.extraArguments)],['tocDepth','Contents depth (1–6)',input('number',String(this.exportOptions.tocDepth ?? 3))]);
      else definitions.push(['paper','Paper',select(['A4','A5','letter','legal'],this.exportOptions.paper)],['margin','Margin (mm)',input('number',String(this.exportOptions.margin))],['width','Image/page width (px)',input('number',String(this.exportOptions.width))],['quality','JPEG quality (0–1)',input('number',String(this.exportOptions.quality))],['splitPages','Page break before major headings',input('checkbox',String(this.exportOptions.splitPages))],['header','Header',input('text',this.exportOptions.header ?? '')],['footer','Footer',input('text',this.exportOptions.footer ?? '')]);
      definitions.push(['postCommand','Post-export executable path (optional)',input('text',this.exportOptions.postCommand ?? '')],['postArguments','Post-export argv (JSON array; ${output} is the output path)',arrayInput(this.exportOptions.postArguments)]);
      for(const [key,label,control] of definitions){control.dataset.exportOption=key;if(key==='tocDepth'){(control as HTMLInputElement).min='1';(control as HTMLInputElement).max='6';}
        control.addEventListener('change',()=>{try{
          const value=key==='extraArguments'||key==='postArguments'?parseUploaderArguments((control as HTMLTextAreaElement).value):control instanceof HTMLInputElement && control.type==='checkbox'?control.checked:control instanceof HTMLInputElement && control.type==='number'?Number(control.value):(control as HTMLInputElement).value;
          this.validateExportOptions({...this.exportOptions,[key]:value});this.exportOptions[key]=value;control.removeAttribute('aria-invalid');
        }catch(error){control.setAttribute('aria-invalid','true');this.report(error);}exportButton.disabled=!!fields.querySelector('[aria-invalid="true"]');});fields.append(field(label,control));
      }
      exportButton.disabled=false;rename.disabled=remove.disabled=!preset.value;
    };
    const load=()=>{if(preset.value && Object.hasOwn(this.preferences.exportPresets,preset.value)){const {format:savedFormat,destination,...options}=this.preferences.exportPresets[preset.value];this.exportOptions={...this.exportOptions,...options};if(formats.some(([name])=>name===savedFormat))format.value=savedFormat;}render();};
    preset.addEventListener('change',load);format.addEventListener('change',render);
    const savePreset=button('Save Preset');savePreset.addEventListener('click',()=>void promptValue(this.root,'Save Export Preset','Preset name').then(async name=>{
      name=name?.trim() ?? null;if(!name)return;if(Object.hasOwn(this.preferences.exportPresets,name))throw new Error('Preset name already exists. Rename or delete it explicitly first.');
      const {destination,...options}=this.exportOptions;this.validateExportOptions(options);this.preferences.exportPresets={...this.preferences.exportPresets,[name]:{...options,format:format.value}};await this.persist();this.exportDialog(name);
    }).catch(error=>this.report(error)));
    rename.addEventListener('click',()=>{const previous=preset.value;if(!previous)return;void promptValue(this.root,'Rename Export Preset','New preset name',previous).then(async name=>{
      name=name?.trim() ?? null;if(!name)return;if(name!==previous && Object.hasOwn(this.preferences.exportPresets,name))throw new Error('Preset name already exists. No preset was overwritten.');
      const value=this.preferences.exportPresets[previous],next={...this.preferences.exportPresets};delete next[previous];next[name]=value;this.preferences.exportPresets=next;await this.persist();this.exportDialog(name);
    }).catch(error=>this.report(error));});
    remove.addEventListener('click',()=>{const name=preset.value;if(!name)return;const confirm=modal(this.root,'Delete Export Preset');confirm.body.textContent=`Delete the preset “${name}”? Exported files are kept.`;const apply=button('Delete Preset','confirm-delete-preset');apply.addEventListener('click',()=>{const next={...this.preferences.exportPresets};delete next[name];this.preferences.exportPresets=next;void this.persist().then(()=>this.exportDialog()).catch(error=>this.report(error));});confirm.footer.append(apply);});
    exportButton.addEventListener('click',()=>{try{this.validateExportOptions(this.exportOptions);const value=format.value;dialog.close();void this.export(value).catch(error=>this.report(error));}catch(error){this.report(error);}});
    dialog.footer.append(savePreset,rename,remove,exportButton);load();
  }
  private toolDialog() {
    const dialog = modal(this.root,'Run External Tool'), executable = input(), argumentsInput = document.createElement('textarea'); argumentsInput.rows = 4; argumentsInput.placeholder = 'One argument per line'; dialog.body.append(field('Executable path',executable),field('Arguments',argumentsInput)); const message = document.createElement('p'); message.textContent = 'The document source is sent to standard input. Output is shown here; the source changes only when you choose Replace Document.'; dialog.body.append(message); const output = document.createElement('pre'); output.className = 'tool-output'; dialog.body.append(output); const run = button('Run'), replace = button('Replace Document'); replace.disabled = true; replace.dataset.toolReplace='true'; let stdout = ''; let origin:MutationOrigin|undefined;
    run.addEventListener('click',() => { if (!executable.value.trim()) { output.textContent = 'Enter an executable path.'; return; } if(this.toolJob){output.textContent='A tool is already running.';return;} const jobId = `tool-${Date.now()}`; this.toolJob = jobId; this.query('[data-action="cancel-job"]').hidden = false; run.disabled = true; origin=this.mutationOrigin();this.toolOrigin=origin;const snapshot=origin.source; void this.client.call<any>('runTool',{jobId,executable:executable.value,arguments:argumentsInput.value ? argumentsInput.value.split(/\r?\n/) : [],input:snapshot,directory:this.current()?.path ? parentPath(this.current()!.path!) : null,timeout:60,maxOutputBytes:8_388_608}).then(result => { stdout = result.stdout ?? ''; output.textContent = `${result.cancelled ? 'Cancelled' : result.timedOut ? 'Timed out' : `Exit ${result.exitCode}`}\n${result.stderr ?? ''}\n${stdout}`; replace.disabled = !origin || !this.originCurrent(origin) || result.exitCode !== 0 || result.cancelled || result.timedOut || result.outputTruncated; if(origin && !this.originCurrent(origin)) output.textContent += '\nDocument or selection changed; replacement is unavailable.'; }).catch(error => { output.textContent = error instanceof Error ? error.message : String(error); }).finally(() => { run.disabled = false; if(this.toolJob===jobId)this.toolJob = ''; if (!this.disposed) this.query('[data-action="cancel-job"]').hidden = !(this.searchJob || this.exportJob || this.toolJob); }); });
    replace.addEventListener('click',() => { try { if(!origin)throw new Error('Run the tool first.');this.requireOrigin(origin);this.editor.replace(stdout);dialog.close(); } catch(error){replace.disabled=true;this.report(error);} }); dialog.footer.append(run,replace);
  }
  private invalidateCloseApproval(){window.dispatchEvent(new Event('mori-document-change'));}
  private clearFileWork(id:string){const timer=this.autoSaveTimers.get(id);if(timer)clearTimeout(timer);this.autoSaveTimers.delete(id);this.autoSaveBlocked.delete(id);this.externalWarnings.delete(id);}
  private stopFileWork(){clearInterval(this.observerTimer);for(const id of this.autoSaveTimers.keys())this.clearFileWork(id);}
  private closeStateSignature(){return JSON.stringify([...this.documents.values()].map(doc=>[doc.documentId,doc.revision,doc.path,doc.encoding,doc.lineEnding]));}
  private async checkpointForClose():Promise<boolean>{
    const signature=this.closeStateSignature();
    for(const doc of [...this.documents.values()].filter(doc=>doc.revision!==doc.savedRevision)){
      this.clearCheckpoint(doc.documentId);
      await this.client.call('checkpoint',{documentId:doc.documentId,text:this.publishedSource(doc),revision:doc.revision});
    }
    return !this.formatJobs.size && signature===this.closeStateSignature() && !this.editor.view.compositionStarted;
  }
  async prepareForClose(reason:'quit'|'window'='window'):Promise<boolean>{
    if(this.disposed)return true;
    if(this.formatJobs.size){this.status('Wait for the encoding change to finish before closing.');return false;}
    if(this.editor.view.compositionStarted){this.status('Finish composing text before closing this window.');return false;}
    while(this.saveQueues.size)await Promise.all([...this.saveQueues.values()]);
    if(this.disposed)return true;
    await this.persist();
    if(this.editor.view.compositionStarted){this.status('Finish composing text before closing this window.');return false;}
    if(!(await this.checkpointForClose())){this.status('Documents changed while preparing to close. Try again after editing.');return false;}
    const dirty=[...this.documents.values()].filter(doc=>this.isDirty(doc));
    if(reason==='quit' && this.preferences.restoreUnsaved){const signature=this.closeStateSignature();for(const doc of dirty){await this.client.call('keepRecovery',{documentId:doc.documentId,revision:doc.revision});this.draftRevisions.set(doc.documentId,doc.revision);}await this.persist();return !this.formatJobs.size&&signature===this.closeStateSignature()&&!this.editor.view.compositionStarted;}
    if(!dirty.length)return true;
    return await new Promise<boolean>(resolve=>{
      const dialog=modal(this.root,'Unsaved documents');const description=document.createElement('p');
      description.textContent=`${dirty.length} document(s) have unsaved changes. A recovery snapshot has been stored. Save now or keep recovery for the next launch.`;dialog.body.append(description);
      let settled=false;const finish=(accepted:boolean)=>{if(settled)return;settled=true;resolve(accepted);dialog.close();};
      const cancel=button('Cancel'),keep=button('Keep Recovery'),save=button('Save All');
      cancel.addEventListener('click',()=>finish(false));
      keep.addEventListener('click',()=>{keep.disabled=true;save.disabled=true;void this.checkpointForClose().then(current=>{if(current)finish(true);else{keep.disabled=false;save.disabled=false;this.status('Documents changed while keeping recovery. Finish editing and try again.');}}).catch(error=>{keep.disabled=false;save.disabled=false;this.report(error);});});
      save.addEventListener('click',()=>{save.disabled=true;void(async()=>{for(const doc of [...this.documents.values()].filter(doc=>this.isDirty(doc))){this.adopt(doc);await this.save();}finish([...this.documents.values()].every(doc=>!this.isDirty(doc))&&!this.editor.view.compositionStarted);})().catch(error=>{save.disabled=false;this.report(error);});});
      dialog.footer.append(cancel,keep,save);
      dialog.element.querySelector('header button')!.addEventListener('click',()=>finish(false));
      dialog.element.addEventListener('cancel',()=>finish(false));
      dialog.element.addEventListener('mori-dismiss',()=>finish(false));
      dialog.element.addEventListener('keydown',event=>{if(event.key==='Escape')finish(false);});
      dialog.element.addEventListener('click',event=>{if(event.target===dialog.element)finish(false);});
    });
  }
  destroy() { if(this.disposed)return;this.disposed = true;this.cancelTypewriterFrame();this.invalidateSearch();this.stopFileWork();this.localizer?.destroy(); this.events.abort(); for (const timer of this.checkpointTimers.values()) clearTimeout(timer); if (this.refreshTimer) clearTimeout(this.refreshTimer); this.media.removeEventListener('change',this.mediaChange); this.outlineNavigator.destroy(); this.editor.destroy(); this.client.dispose(); if ((window as any).__nativeCommand === this.nativeReceiver) (window as any).__nativeCommand = typeof this.nativePrevious === 'function' ? this.nativePrevious : () => {}; if((window as any).__moriBeforeClose===this.closeReceiver)(window as any).__moriBeforeClose=this.closePrevious;this.root.querySelector('dialog')?.dispatchEvent(new Event('mori-dismiss'));this.root.replaceChildren(); }
}
export async function mountApp(root: HTMLElement, client?: NativeClient): Promise<MoriApp> { const app = new MoriApp(root,client); await app.start(); return app; }
if (typeof document !== 'undefined') { const root = document.getElementById('app'); if (root) void mountApp(root).catch(error => { root.textContent = error instanceof Error ? error.message : String(error); }); }
