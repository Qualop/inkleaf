import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { parser } from '@lezer/markdown';

export interface ProofreadingIssue { from:number; to:number; kind:'spelling'|'grammar'; message:string; suggestions:string[] }
export interface ProofreadingResult { issues:ProofreadingIssue[]; languages:string[]; language:string; note?:string }
export interface ProofreadingOptions {
  check:(text:string)=>Promise<ProofreadingResult>;
  enabled?:()=>boolean;
  getText?:(state:EditorState)=>string;
  onLearn?:(word:string)=>void|Promise<void>;
  onResult?:(result:ProofreadingResult)=>void;
  onError?:(error:unknown)=>void;
  uiLanguage?:()=>string;
  debounceMs?:number;
}
export const MAX_PROOFREADING_ISSUES = 200;
const MAX_TEXT = 50000;
const normalized = (text:string) => text.replace(/\r\n|\r/g,'\n');
const empty = ():ProofreadingResult => ({issues:[],languages:[],language:''});
const englishUI = (options:ProofreadingOptions) => /^en(?:[-_]|$)/i.test(options.uiLanguage?.()??'ko');
function messageForUI(message:string,english:boolean):string {
  if(!english)return message;
  const known:Record<string,string>={
    '철자를 확인하세요.':'Check spelling.',
    '한국어 표기를 확인하세요.':'Check Korean spelling.',
    '문법과 띄어쓰기를 확인하세요.':'Check grammar and spacing.',
    '의존 명사 ‘수’는 앞말과 띄어 씁니다.':'Separate the dependent noun ‘수’ from the preceding word.',
  };
  return known[message]??message;
}
const toCM = (text:string,offset:number) => normalized(text.slice(0,offset)).length;
const boundary = (text:string,offset:number) => !(offset>0 && offset<text.length && ((text[offset-1]==='\r' && text[offset]==='\n') || (/[\uD800-\uDBFF]/.test(text[offset-1]) && /[\uDC00-\uDFFF]/.test(text[offset]))));
type Span = {from:number;to:number};

function exclusions(text:string):Span[] {
  const spans:Span[]=[];
  const excluded=/^(?:FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag|Autolink|URL|LinkTitle|LinkReference|LinkMark|CodeMark|CodeInfo|HeaderMark|EmphasisMark|QuoteMark|ListMark|Escape|Entity|HorizontalRule)$/;
  parser.parse(text).iterate({enter(node) {
    if (excluded.test(node.name)) {spans.push({from:node.from,to:node.to});return false;}
  }});
  for(const pattern of [/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/g, /\$\$[\s\S]*?\$\$|\$[^$\r\n]+\$/g, /(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+/gi, /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi]) {
    for(const match of text.matchAll(pattern)) spans.push({from:match.index,to:match.index+match[0].length});
  }
  return spans.sort((a,b)=>a.from-b.from);
}
const overlaps = (range:Span,spans:Span[]) => spans.some(span=>range.from<span.to && range.to>span.from);

/** Validate bridge replies before they become source replacements or decorations. */
export function normalizeProofreadingResult(text:string,value:unknown):ProofreadingResult {
  const object=value && typeof value==='object' ? value as Record<string,unknown> : {};
  const result:ProofreadingResult={issues:[],languages:Array.isArray(object.languages)?[...new Set(object.languages.filter((v):v is string=>typeof v==='string' && v.length<80))].slice(0,200):[],language:typeof object.language==='string'?object.language.slice(0,80):''};
  if(typeof object.note==='string')result.note=object.note.slice(0,1000);
  if(!Array.isArray(object.issues))return result;
  const spans=exclusions(text.slice(0,MAX_TEXT)),seen=new Set<string>();
  for(const item of object.issues.slice(0,2000)) {
    if(!item || typeof item!=='object')continue;
    const {from,to,kind,message,suggestions}=item;
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>Math.min(text.length,MAX_TEXT)||(kind!=='spelling'&&kind!=='grammar')||!boundary(text,from)||!boundary(text,to)||overlaps({from,to},spans))continue;
    const key=`${from}:${to}`;if(seen.has(key))continue;seen.add(key);
    result.issues.push({from,to,kind,message:typeof message==='string'?message.slice(0,500):(kind==='spelling'?'철자를 확인하세요.':'문법과 띄어쓰기를 확인하세요.'),suggestions:Array.isArray(suggestions)?[...new Set(suggestions.filter((word):word is string=>typeof word==='string'&&!!word.trim()&&word.length<=200&&!/[\r\n]/.test(word)))].slice(0,8):[]});
    if(result.issues.length>=MAX_PROOFREADING_ISSUES)break;
  }
  result.issues.sort((a,b)=>a.from-b.from||a.to-b.to);
  return result;
}

export const setProofreadingResult = StateEffect.define<{text:string;result:ProofreadingResult}>();
const refreshEffect = StateEffect.define<null>();
interface ProofreadingSnapshot {text:string;issues:ProofreadingIssue[];result:ProofreadingResult;decorations:DecorationSet}
const initialSnapshot = ():ProofreadingSnapshot => ({text:'',issues:[],result:empty(),decorations:Decoration.none});
export const proofreadingState = StateField.define<ProofreadingSnapshot>({
  create:initialSnapshot,
  update(value,transaction) {
    if(transaction.docChanged || transaction.effects.some(effect=>effect.is(refreshEffect)))value=initialSnapshot();
    for(const effect of transaction.effects)if(effect.is(setProofreadingResult) && normalized(effect.value.text)===transaction.state.doc.toString()) {
      const {text}=effect.value,result=normalizeProofreadingResult(text,effect.value.result);
      const marks=result.issues.map(issue=>Decoration.mark({class:`mori-${issue.kind}`,attributes:{title:issue.message,'data-proofreading-from':String(issue.from),'data-proofreading-to':String(issue.to)}}).range(toCM(text,issue.from),toCM(text,issue.to)));
      value={text,result,issues:result.issues,decorations:Decoration.set(marks,true)};
    }
    return value;
  },
  provide:field=>EditorView.decorations.from(field,value=>value.decorations),
});

export function applyProofreadingSuggestion(view:EditorView,issue:ProofreadingIssue,suggestion:string,expectedText:string):boolean {
  if(view.state.readOnly || normalized(expectedText)!==view.state.doc.toString() || typeof suggestion!=='string'||!suggestion.trim()||suggestion.length>200||/[\r\n]/.test(suggestion))return false;
  const checked=normalizeProofreadingResult(expectedText,{issues:[issue]});
  if(checked.issues.length!==1 || !issue.suggestions.includes(suggestion))return false;
  const from=toCM(expectedText,issue.from),to=toCM(expectedText,issue.to);
  view.dispatch({changes:{from,to,insert:suggestion},selection:{anchor:from+suggestion.length},annotations:[Transaction.userEvent.of('input.proofreading'),isolateHistory.of('full')]});
  view.focus();return true;
}

class ProofreadingPlugin {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private generation=0;
  private destroyed=false;
  private source:string;
  private popup:HTMLElement|null=null;
  readonly view:EditorView;
  readonly options:ProofreadingOptions;
  constructor(view:EditorView,options:ProofreadingOptions) {this.view=view;this.options=options;this.source=this.text();this.schedule();}
  private text() {return this.options.getText?.(this.view.state)??this.view.state.doc.toString();}
  update(update:ViewUpdate) {
    const source=this.text();
    if(update.docChanged || source!==this.source || update.transactions.some(t=>t.effects.some(effect=>effect.is(refreshEffect)))) {
      this.source=source;this.close();this.schedule();
    }
  }
  private schedule() {
    const generation=++this.generation;
    if(this.timer!==undefined)clearTimeout(this.timer);
    this.timer=undefined;
    if(this.destroyed || this.view.compositionStarted)return;
    this.timer=setTimeout(()=>{this.timer=undefined;void this.check(generation);},Math.max(0,Math.min(this.options.debounceMs??450,5000)));
  }
  startComposition() {
    ++this.generation;
    if(this.timer!==undefined)clearTimeout(this.timer);
    this.timer=undefined;this.close();
  }
  endComposition() {
    queueMicrotask(()=>{if(!this.destroyed)this.schedule();});
  }
  private async check(generation:number) {
    if(this.destroyed || generation!==this.generation || this.view.compositionStarted)return;
    const text=this.text(),doc=this.view.state.doc;
    const current=()=>!this.destroyed && generation===this.generation && !this.view.compositionStarted && this.view.state.doc===doc && text===this.text();
    if(this.options.enabled?.()===false) {
      if(current())this.view.dispatch({effects:setProofreadingResult.of({text,result:empty()})});return;
    }
    try {
      const result=normalizeProofreadingResult(text,await this.options.check(text));
      if(!current() || this.options.enabled?.()===false)return;
      if(englishUI(this.options))result.issues=result.issues.map(issue=>({...issue,message:messageForUI(issue.message,true)}));
      this.view.dispatch({effects:setProofreadingResult.of({text,result})});this.options.onResult?.(result);
    } catch(error) {
      if(current()){this.view.dispatch({effects:setProofreadingResult.of({text,result:empty()})});this.options.onError?.(error);}
    }
  }
  close() {this.popup?.remove();this.popup=null;}
  show(issue:ProofreadingIssue):boolean {
    const snapshot=this.view.state.field(proofreadingState),text=snapshot.text,doc=this.view.state.doc;
    if(!snapshot.issues.includes(issue) || this.options.enabled?.()===false || this.view.state.readOnly)return false;
    this.close();const document=this.view.dom.ownerDocument,popup=document.createElement('div');this.popup=popup;
    const english=englishUI(this.options);
    popup.className='mori-proofreading-menu';popup.setAttribute('role','dialog');popup.setAttribute('aria-label',english?(issue.kind==='spelling'?'Spelling suggestions':'Grammar and spacing suggestions'):'맞춤법 제안');
    const message=document.createElement('p');message.textContent=messageForUI(issue.message,english);popup.append(message);
    const current=()=>this.view.state.doc===doc && this.text()===text && this.popup===popup;
    const button=(label:string,action:()=>void)=>{const element=document.createElement('button');element.type='button';element.textContent=label;element.addEventListener('click',action);popup.append(element);return element;};
    for(const suggestion of issue.suggestions)button(suggestion,()=>{if(current())applyProofreadingSuggestion(this.view,issue,suggestion,text);this.close();}).dataset.proofreadingSuggestion=suggestion;
    if(!issue.suggestions.length){const unavailable=document.createElement('p');unavailable.textContent=english?'No suggestions available.':'추천 단어가 없습니다.';popup.append(unavailable);}
    if(this.options.onLearn && issue.kind==='spelling')button(english?'Add to personal dictionary':'개인 사전에 추가',()=>{
      if(!current())return this.close();const word=text.slice(issue.from,issue.to);this.close();
      Promise.resolve().then(()=>this.options.onLearn!(word)).then(()=>{if(!this.destroyed)refreshProofreading(this.view);}).catch(error=>this.options.onError?.(error));
    });
    button(english?'Close':'닫기',()=>{this.close();this.view.focus();});
    popup.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();this.close();this.view.focus();}
      if(event.key==='Tab'){const buttons=[...popup.querySelectorAll('button')];if(buttons.length){event.preventDefault();const index=buttons.indexOf(document.activeElement as HTMLButtonElement),next=(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length;buttons[next].focus();}}
    });
    let x=8,y=8;try{const coords=this.view.coordsAtPos(toCM(text,issue.from));if(coords){x=coords.left;y=coords.bottom;}}catch{}
    popup.style.left=`${Math.max(8,Math.min(x,(document.defaultView?.innerWidth??800)-260))}px`;
    popup.style.top=`${Math.max(8,Math.min(y+4,(document.defaultView?.innerHeight??600)-220))}px`;
    this.view.dom.append(popup);popup.querySelector('button')?.focus();return true;
  }
  destroy() {this.destroyed=true;++this.generation;if(this.timer!==undefined)clearTimeout(this.timer);this.close();}
}
const plugins=new WeakMap<EditorView,ProofreadingPlugin>();
export function refreshProofreading(view:EditorView):void {view.dispatch({effects:refreshEffect.of(null)});}
export function showProofreadingSuggestions(view:EditorView):boolean {
  const snapshot=view.state.field(proofreadingState,false);if(!snapshot)return false;
  const cursor=view.state.selection.main.head;
  const issue=snapshot.issues.find(issue=>toCM(snapshot.text,issue.from)<=cursor&&toCM(snapshot.text,issue.to)>=cursor);
  return issue ? plugins.get(view)?.show(issue)??false : false;
}

export function proofreading(options:ProofreadingOptions):Extension {
  const plugin=ViewPlugin.define(view=>{const value=new ProofreadingPlugin(view,options);plugins.set(view,value);return value;},{eventHandlers:{
    compositionstart() {this.startComposition();return false;},
    compositionend() {this.endComposition();return false;},
    click(event,view) {
      const mark=(event.target as Element|null)?.closest?.('[data-proofreading-from]');if(!mark)return false;
      const issue=view.state.field(proofreadingState).issues.find(issue=>issue.from===Number(mark.getAttribute('data-proofreading-from')));
      return issue?this.show(issue):false;
    },
    contextmenu(event,view) {
      const mark=(event.target as Element|null)?.closest?.('[data-proofreading-from]');
      const snapshot=view.state.field(proofreadingState);
      const position=mark?undefined:view.posAtCoords({x:event.clientX,y:event.clientY});
      const issue=snapshot.issues.find(issue=>mark?issue.from===Number(mark.getAttribute('data-proofreading-from')):position!=null&&toCM(snapshot.text,issue.from)<=position&&toCM(snapshot.text,issue.to)>=position);
      if(!issue||!this.show(issue))return false;event.preventDefault();return true;
    },
  }});
  return [proofreadingState,plugin,keymap.of([{key:'Alt-Enter',run:showProofreadingSuggestions},{key:'Escape',run:view=>{const plugin=plugins.get(view);plugin?.close();return false;}}]),EditorView.baseTheme({
    '.mori-spelling':{'text-decoration-line':'underline','text-decoration-style':'wavy','text-decoration-color':'#dc2626','text-underline-offset':'3px'},
    '.mori-grammar':{'text-decoration-line':'underline','text-decoration-style':'wavy','text-decoration-color':'#2563eb','text-underline-offset':'3px'},
    '.mori-proofreading-menu':{position:'fixed','z-index':'1000',width:'244px','max-height':'210px',overflow:'auto',padding:'8px',border:'1px solid #888','border-radius':'6px',background:'Canvas',color:'CanvasText','box-shadow':'0 4px 16px #0003','font-family':'system-ui','font-size':'13px','white-space':'normal'},
    '.mori-proofreading-menu p':{margin:'4px 0 8px'},
    '.mori-proofreading-menu button':{display:'block',width:'100%',padding:'6px 8px',border:'0','text-align':'left',background:'transparent',color:'inherit',cursor:'pointer'},
    '.mori-proofreading-menu button:focus-visible':{outline:'2px solid #2563eb','outline-offset':'-2px'},
    '.mori-proofreading-menu button:hover':{background:'ButtonFace',color:'ButtonText'},
  })];
}

export interface PreviewProofreadingOptions {from?:number;to?:number;onIssue?:(issue:ProofreadingIssue)=>void}
/** Exact, sequential source matching; ambiguous transformed text remains unmarked. */
export function annotatePreview(root:HTMLElement,source:string,value:ProofreadingResult,options:PreviewProofreadingOptions={}):void {
  for(const mark of root.querySelectorAll('[data-mori-proofreading]'))mark.replaceWith(root.ownerDocument.createTextNode(mark.textContent??''));
  root.normalize();
  const result=normalizeProofreadingResult(source,value),spans=exclusions(source.slice(0,MAX_TEXT)),document=root.ownerDocument;
  const walker=document.createTreeWalker(root,4),nodes:Text[]=[];
  while(walker.nextNode()){const node=walker.currentNode as Text;if(!node.parentElement?.closest('code,pre,script,style,svg,math,mjx-container,.katex'))nodes.push(node);}
  let cursor=options.from??0;const limit=options.to??source.length;
  for(const node of nodes) {
    const content=node.data;if(!content.trim())continue;
    let from=source.indexOf(content,cursor);
    while(from>=0 && overlaps({from,to:from+content.length},spans))from=source.indexOf(content,from+1);
    if(from<0 || from+content.length>limit)continue;
    cursor=from+content.length;
    const issues=result.issues.filter(issue=>issue.from>=from && issue.to<=cursor);if(!issues.length)continue;
    const fragment=document.createDocumentFragment();let at=0;
    for(const issue of issues) {
      const localFrom=issue.from-from,localTo=issue.to-from;if(localFrom<at)continue;
      fragment.append(document.createTextNode(content.slice(at,localFrom)));
      const mark=document.createElement('span');mark.className=`mori-${issue.kind}`;mark.dataset.moriProofreading='true';mark.dataset.proofreadingFrom=String(issue.from);mark.dataset.proofreadingTo=String(issue.to);mark.textContent=content.slice(localFrom,localTo);mark.title=issue.message;
      mark.style.textDecoration=`underline wavy ${issue.kind==='spelling'?'#dc2626':'#2563eb'}`;mark.style.textUnderlineOffset='3px';
      if(options.onIssue){mark.tabIndex=0;mark.setAttribute('role','button');mark.setAttribute('aria-label',`${mark.textContent}: ${issue.message}`);mark.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();options.onIssue!(issue);});mark.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();options.onIssue!(issue);}});}
      fragment.append(mark);at=localTo;
    }
    fragment.append(document.createTextNode(content.slice(at)));node.replaceWith(fragment);
  }
}
