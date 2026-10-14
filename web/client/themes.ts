export interface DocumentTheme { id: string; name: string; css: string; appearance?: 'light'|'dark'; description?: string }
const palette = (canvas:string,text:string,muted:string,line:string,accent:string,font:string) => `.mori-app[data-document-theme]{--canvas:${canvas};--chrome:${canvas};--surface:${canvas};--text:${text};--muted:${muted};--line:${line};--accent:${accent};--theme-font:${font}}`;
const serif='Georgia,"Noto Serif KR",ui-serif,serif',sans='-apple-system,BlinkMacSystemFont,system-ui,sans-serif';
export const builtInThemes:DocumentTheme[] = [
  {id:'default',name:'Default',css:'',description:'Clean document, follows the system appearance'},
  {id:'github',name:'GitHub',appearance:'light',description:'Clear headings, sans-serif text, blue links',css:palette('#ffffff','#24292f','#656d76','#d0d7de','#0969da',sans)+'.markdown-body h1,.markdown-body h2,.live-heading-1,.live-heading-2{padding-bottom:.25em;border-bottom:1px solid var(--line)}'},
  {id:'newsprint',name:'Newsprint',appearance:'light',description:'Warm paper and serif text',css:palette('#f3f1e9','#35352f','#6c6a61','#d9d5ca','#685b3c',serif)+'.markdown-body h1,.markdown-body h2,.live-heading{letter-spacing:0;font-weight:700}.markdown-body pre{background:#e9e6dc}'},
  {id:'night',name:'Night',appearance:'dark',description:'Soft dark background for evening writing',css:palette('#272b30','#e1e4e8','#aeb6c0','#444c56','#9bbfe2',sans)+'.mori-app{--selected:#394b5e}.markdown-body pre{background:#202429}'},
  {id:'pixyll',name:'Pixyll',appearance:'light',description:'Serif paragraphs and compact sans-serif headings',css:palette('#ffffff','#333333','#707070','#e2e2e2','#427b8a',serif)+'.markdown-body h1,.markdown-body h2,.markdown-body h3,.live-heading{font-family:'+sans+';font-weight:700}.markdown-body a{text-decoration:underline}'},
  {id:'whitey',name:'Whitey',appearance:'light',description:'Quiet neutral page and restrained headings',css:palette('#fafafa','#343434','#737373','#dedede','#555555',sans)+'.markdown-body h1,.live-heading-1{font-weight:500}.markdown-body blockquote{font-style:italic}.markdown-body pre{background:#f0f0f0}'}
];
const surfaces=['.cm-content','.reading','.theme-preview'];

function splitSelectors(value:string):string[] {
  const result:string[]=[];let from=0,depth=0,quote='';
  for(let i=0;i<value.length;i++) {const ch=value[i];if(quote){if(ch==='\\')i++;else if(ch===quote)quote='';continue;}if(ch==='"'||ch==="'")quote=ch;else if(ch==='('||ch==='[')depth++;else if(ch===')'||ch===']')depth--;else if(ch===','&&depth===0){result.push(value.slice(from,i).trim());from=i+1;}}
  result.push(value.slice(from).trim());return result.filter(Boolean);
}
function selectors(value:string):string {
  return splitSelectors(value).flatMap(selector=>{
    if(selector===':root')return ['.mori-app[data-document-theme]'];
    if(selector==='#document-sidebar')return ['.mori-app .sidebar'];
    if(selector.startsWith('#document-source'))return ['.mori-app .cm-editor[data-mode="source"] .cm-content'+selector.slice('#document-source'.length)];
    const tail=selector.replace(/^(?:html\s+)?(?:body\s*)?(?:#write\s*)?/,'');
    const scoped=surfaces.map(surface=>'.mori-app '+surface+(tail?' '+tail:''));
    const heading=/^(?:#write\s+)?h([1-6])$/.exec(selector);
    if(heading)scoped.push('.mori-app .live-heading-'+heading[1]);
    return scoped;
  }).join(',');
}

/** CSS is scoped to document surfaces. The native importer embeds permitted local assets first. */
export function scopeThemeCSS(source:string):string {
  if(source.length>1_048_576)throw new Error('Theme stylesheet is too large.');
  if(/@import\b/i.test(source))throw new Error('Theme imports must be embedded by the native importer.');
  for(const match of source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)){
    const url=(match[1]??match[2]??match[3]??'').trim();if(url && !url.startsWith('data:') && !url.startsWith('#'))throw new Error('Theme resource URL must be an embedded local asset.');
  }
  const documentVariables:string[]=[];
  function rules(css:string):string {
    let output='',start=0,quote='',comment=false,round=0;
    for(let i=0;i<css.length;i++){
      const ch=css[i],next=css[i+1];
      if(comment){if(ch==='*'&&next==='/'){comment=false;i++;}continue;}
      if(quote){if(ch==='\\')i++;else if(ch===quote)quote='';continue;}
      if(ch==='/'&&next==='*'){comment=true;i++;continue;}
      if(ch==='"'||ch==="'"){quote=ch;continue;}
      if(ch==='(')round++;else if(ch===')')round--;
      if(round!==0||ch!=='{')continue;
      const header=css.slice(start,i).replace(/\/\*[\s\S]*?\*\//g,'').trim();let end=i+1,depth=1,q='',c=false;
      for(;end<css.length;end++){const t=css[end],n=css[end+1];if(c){if(t==='*'&&n==='/'){c=false;end++;}continue;}if(q){if(t==='\\')end++;else if(t===q)q='';continue;}if(t==='/'&&n==='*'){c=true;end++;}else if(t==='"'||t==="'")q=t;else if(t==='{')depth++;else if(t==='}'&&--depth===0)break;}
      if(depth!==0)throw new Error('Unclosed theme CSS syntax.');
      const body=css.slice(i+1,end);
      if(/^@(media|supports|layer|container)\b/i.test(header))output+=header+'{'+rules(body)+'}';
      else if(/^@(?:font-face|(?:-webkit-)?keyframes)\b/i.test(header))output+=header+'{'+body+'}';
      else if(header.startsWith('@'))throw new Error('Unsupported theme CSS syntax: '+header);
      else {if(!header || header.includes(';'))throw new Error('Invalid theme CSS syntax.');output+=selectors(header)+'{'+body+'}';if(splitSelectors(header).some(selector=>['body','html','html body','#write'].includes(selector))){for(const [property,variable] of [['color','--text'],['background-color','--canvas'],['background','--canvas'],['font-family','--theme-font']]){const match=new RegExp('(?:^|;)\\s*'+property+'\\s*:\\s*([^;]+)','i').exec(body);if(match)documentVariables.push(variable+':'+match[1].replace(/!important\s*$/i,'').trim());}}}
      start=end+1;i=end;
    }
    if(css.slice(start).replace(/\/\*[\s\S]*?\*\//g,'').trim() || quote || comment || round)throw new Error('Invalid theme CSS syntax.');
    return output;
  }
  const scoped=rules(source.replace(/^\s*@charset\s+["'][^"']+["']\s*;/i,''));
  // Common document-theme variables remain usable without changing other app UI.
  const variables=[/--bg-color\s*:/i.test(source)?'--canvas:var(--bg-color)':'',/--text-color\s*:/i.test(source)?'--text:var(--text-color)':''].filter(Boolean);
  const mapped=[...documentVariables,...variables];return scoped+(mapped.length?'\n.mori-app[data-document-theme]{'+mapped.join(';')+'}':'');
}
export function normalizeUserThemes(value:unknown):DocumentTheme[] {
  if(!Array.isArray(value))return [];
  return value.flatMap(theme=>{
    if(!theme || typeof theme.id!=='string'||!/^[-a-zA-Z0-9_.]+$/.test(theme.id)||theme.id.includes('..')||typeof theme.name!=='string'||typeof theme.css!=='string')return [];
    try{return [{id:'user:'+theme.id,name:theme.name,css:scopeThemeCSS(theme.css)}];}catch{return [];}
  });
}
export function resolveDocumentTheme(id:string,userThemes:DocumentTheme[]):DocumentTheme {return [...builtInThemes,...userThemes].find(theme=>theme.id===id)??builtInThemes[0];}
export function themeExportCSS(theme:DocumentTheme):string {if(!theme.css)return '';return (theme.css.replace(/\.mori-app\s+\.(?:cm-content|reading|theme-preview)/g,'article').replace(/\.mori-app\[data-document-theme\]/g,'body').replace(/\.mori-app/g,'body').replace(/\.markdown-body/g,'article')+'\nbody{color:var(--text);background:var(--canvas);font-family:var(--theme-font,-apple-system,system-ui,sans-serif)}article{color:inherit}').replace(/<\/style/gi,'<\\/style');}
