import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import mark from 'markdown-it-mark';
import sub from 'markdown-it-sub';
import sup from 'markdown-it-sup';
import tasks from 'markdown-it-task-lists';
import createDOMPurify from 'dompurify';
import highlight from 'highlight.js';
import { getOutline } from '../core/statistics.ts';
import { frontMatterRange } from '../core/source.ts';

export type MarkdownBlock = {from:number;to:number;html:string;type:string;contentTo?:number};
export type ExportOptions = {
  title?:string;author?:string;css?:string;paper?:string;margin?:number;dark?:boolean;
  outline?:boolean;tocDepth?:number;header?:string;footer?:string;appendHead?:string;appendBody?:string;
  splitPages?:boolean;baseURL?:string;
};
export const escapeHTML=(text:string)=>text.replace(/[&<>"']/g,ch=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[ch]!));
const engine=new MarkdownIt({html:true,linkify:true,breaks:false,typographer:false,
  highlight:(code:string,language:string)=>language&&highlight.getLanguage(language)?highlight.highlight(code,{language,ignoreIllegals:true}).value:''})
  .use(footnote).use(mark).use(sub).use(sup).use(tasks,{enabled:true,label:false});
const stripPrivateTaskMarker=(html:string)=>html.replace(/\sdata-mori-task(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?/gi,'');
engine.core.ruler.after('github-task-lists','mori_task_identity',(state:any)=>{
  for(let index=2;index<state.tokens.length;index++){
    const token=state.tokens[index],item=state.tokens[index-2];
    if(token.type==='inline'&&state.tokens[index-1].type==='paragraph_open'&&item.type==='list_item_open'&&item.attrGet('class')?.includes('task-list-item')){
      const checkbox=token.children?.[0];if(checkbox?.type==='html_inline'&&checkbox.content.startsWith('<input'))checkbox.meta={moriGeneratedTask:true};
    }
  }
});
engine.renderer.rules.html_inline=(tokens:any[],index:number)=>tokens[index].meta?.moriGeneratedTask?tokens[index].content.replace('<input','<input data-mori-task="true"'):stripPrivateTaskMarker(tokens[index].content);
engine.renderer.rules.html_block=(tokens:any[],index:number)=>stripPrivateTaskMarker(tokens[index].content);
let strictMarkdown=false;
export function configureMarkdown(options:{autoLinks:boolean;smartPunctuation:boolean;renderHTML:boolean;strictSyntax?:boolean}):void{
  strictMarkdown=options.strictSyntax===true;
  engine.set({linkify:!strictMarkdown&&options.autoLinks,typographer:options.smartPunctuation,html:options.renderHTML});
  const extensions=['table','strikethrough','footnote_inline','footnote_ref','footnote_def','footnote_tail','mark','sub','sup','github-task-lists'];
  if(strictMarkdown)engine.disable(extensions,true);else engine.enable(extensions,true);
}

engine.inline.ruler.before('escape','mori_inline_math',(state:any,silent:boolean)=>{
  const start=state.pos;
  if(state.src[start]!=='$'||state.src[start+1]==='$'||/\s/.test(state.src[start+1]||''))return false;
  let end=start+1;
  while((end=state.src.indexOf('$',end))>=0){
    let slashes=0;for(let before=end-1;before>=0&&state.src[before]==='\\';before--)slashes++;
    if(slashes%2){end++;continue;}
    if(end===start+1||/\s/.test(state.src[end-1]))return false;
    if(!silent){const token=state.push('mori_math','',0);token.content=state.src.slice(start+1,end);}
    state.pos=end+1;return true;
  }
  return false;
});
engine.renderer.rules.mori_math=(tokens:any[],index:number)=>
  `<span class="math-inline" data-math="inline">${escapeHTML(tokens[index].content)}</span>`;
engine.block.ruler.before('fence','mori_math_block',(state:any,start:number,end:number,silent:boolean)=>{
  const first=state.src.slice(state.bMarks[start]+state.tShift[start],state.eMarks[start]);
  if(!first.startsWith('$$'))return false;
  let content=first.slice(2),next=start+1;
  if(content.endsWith('$$'))content=content.slice(0,-2);
  else{
    const parts:string[]=[];if(content)parts.push(content);let found=false;
    for(;next<end;next++){
      const line=state.src.slice(state.bMarks[next]+state.tShift[next],state.eMarks[next]);
      if(line.trim()==='$$'){found=true;next++;break;}parts.push(line);
    }
    if(!found)return false;content=parts.join('\n');
  }
  if(silent)return true;
  const token=state.push('mori_math_block','div',0);token.content=content;token.map=[start,next];token.block=true;
  state.line=next;return true;
},{alt:['paragraph','reference','blockquote','list']});
engine.renderer.rules.mori_math_block=(tokens:any[],index:number)=>
  `<div class="math-block" data-math="block">${escapeHTML(tokens[index].content)}</div>\n`;
const originalFence=engine.renderer.rules.fence!;
engine.renderer.rules.fence=(tokens:any[],index:number,options:any,env:any,renderer:any)=>{
  const token=tokens[index],lang=token.info.trim().split(/\s+/)[0].toLowerCase();
  if(['mermaid','sequence','flow'].includes(lang))return `<div class="diagram" data-diagram="${lang}">${escapeHTML(token.content)}</div>\n`;
  if(lang==='math'||lang==='latex')return `<div class="math-block" data-math="block">${escapeHTML(token.content)}</div>\n`;
  return originalFence(tokens,index,options,env,renderer);
};
engine.core.ruler.after('inline','mori_structure',(state:any)=>{
  const headings=new Map(getOutline(state.src).map(heading=>[heading.line-1,heading]));
  for(let i=0;i<state.tokens.length;i++){
    const token=state.tokens[i];
    if(token.type==='heading_open'){
      const heading=headings.get(token.map?.[0]);
      if(heading)token.attrSet('id',heading.id);
    }
    if(!strictMarkdown&&token.type==='blockquote_open'&&state.tokens[i+2]?.type==='inline'){
      const inline=state.tokens[i+2],found=inline.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|\s|$)/);
      if(found){token.attrSet('data-alert',found[1].toLowerCase());token.attrSet('class',`alert alert-${found[1].toLowerCase()}`);
        inline.content=inline.content.slice(found[0].length);inline.children=[];
        state.md.inline.parse(inline.content,state.md,state.env,inline.children);}
    }
  }
});
let purifier:any;
export function sanitizeHTML(html:string):string{
  if(!purifier){const win=(globalThis as any).window;if(!win)throw new Error('HTML renderer requires a document environment');purifier=createDOMPurify(win);}
  return purifier.sanitize(html,{USE_PROFILES:{html:true,svg:true,mathMl:true},ADD_TAGS:['video','audio','source'],
    ADD_ATTR:['controls','target'],FORBID_TAGS:['script','object','embed','iframe'],FORBID_ATTR:['srcdoc']});
}
export function renderMarkdown(text:string):string{
  const frontMatter=frontMatterRange(text);
  return sanitizeHTML(engine.render(frontMatter?text.slice(frontMatter.to):text));
}
export function markdownBlocks(text:string,options:{preserveSourceLines?:boolean}={}):MarkdownBlock[]{
  const lines=text.split(/\n/),positions=[0];
  for(let i=0;i<lines.length;i++)positions.push(positions[i]+lines[i].length+(i<lines.length-1?1:0));
  const tokens=engine.parse(text,{}),result:MarkdownBlock[]=[];let i=0;
  while(i<tokens.length){
    const token=tokens[i];if(!token.map||token.level!==0||token.type.endsWith('_close')){i++;continue;}
    const start=i;let end=i+1;
    if(token.nesting===1){let depth=1;while(end<tokens.length&&depth>0){depth+=tokens[end].nesting;end++;}}
    const from=positions[token.map[0]]??text.length,to=positions[token.map[1]]??text.length;
    const selected=tokens.slice(start,end);
    const html=sanitizeHTML(engine.renderer.render(selected,options.preserveSourceLines?{...engine.options,breaks:true}:engine.options,{}));
    const contentEnd=selected.reduce((last,item)=>item.map&&!item.type.endsWith('_close')?item.map[1]:last,token.map[1]);
    result.push({from,to,html,type:token.type.replace(/_open$/,''),...(options.preserveSourceLines?{contentTo:positions[contentEnd]??to}:{})});i=end;
  }
  return result;
}
export function exportHTML(text:string,options:ExportOptions={}):string{
  const title=options.title||text.match(/^#\s+(.+)/m)?.[1]||'문서';
  const paper=/^(A[0-6]|letter|legal|tabloid)$/i.test(options.paper||'')?options.paper:'A4';
  const margin=Number.isFinite(options.margin)?Math.max(0,Math.min(100,options.margin!)):20;
  const base=options.baseURL?`<base href="${escapeHTML(options.baseURL)}">`:'';
  const author=options.author?`<meta name="author" content="${escapeHTML(options.author)}">`:'';
  const toc=options.outline?`<nav>${getOutline(text).filter(heading=>heading.level<=(options.tocDepth??6)).map(heading=>`<a href="#${escapeHTML(heading.id)}">${escapeHTML(heading.title)}</a>`).join('\n')}</nav>`:'';
  const styles=`@page{size:${paper};margin:${margin}mm}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.7;max-width:860px;margin:0 auto;padding:30px;color:${options.dark?'#e4e2df':'#222'};background:${options.dark?'#202120':'#fff'}}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:.5em}pre{white-space:pre-wrap;padding:1em;background:#f0f0ed;color:#222}img,svg{max-width:100%}blockquote{margin-left:0;padding-left:1em;border-left:3px solid #999}.math-block{text-align:center}mjx-assistive-mml{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}nav a{display:block}h1,h2{break-after:avoid}${options.splitPages?'h1:not(:first-of-type){break-before:page}':''}`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title>${author}${base}<style>${styles}\n${options.css||''}</style>${sanitizeHTML(options.appendHead||'')}</head><body>${options.header?`<header>${escapeHTML(options.header)}</header>`:''}${toc}<article>${renderMarkdown(text)}</article>${sanitizeHTML(options.appendBody||'')}${options.footer?`<footer>${escapeHTML(options.footer)}</footer>`:''}</body></html>`;
}
export function exportFilename(path:string|null,text:string,extension:string):string{
  const basename=path?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/,'');const heading=text.match(/^#\s+(.+)$/m)?.[1];
  const name=(basename||heading||'문서').replace(/[\\/:*?"<>|]+/g,'-').trim()||'문서';return `${name}.${extension.replace(/^\./,'')}`;
}
