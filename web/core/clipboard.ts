import createDOMPurify from 'dompurify';

/** Conservative rich-paste conversion. Complex structures retain their sanitized HTML. */
export function htmlToMarkdown(html:string):string {
  const win=(globalThis as any).window;if(!win)throw new Error('Rich paste requires a document environment.');
  const doc=win.document.implementation.createHTMLDocument('');
  doc.body.append(createDOMPurify(win).sanitize(html,{FORBID_TAGS:['script','style','iframe','object','embed'],RETURN_DOM_FRAGMENT:true}));
  let delimiter='\uE000';while(doc.body.innerHTML.includes(delimiter))delimiter+='\uE000';
  const literals:string[]=[],literalPattern=new RegExp(delimiter+'(\\d+)'+delimiter,'g');
  // Keep code lines nonempty until container indentation and prose whitespace cleanup finish.
  const protectLines=(value:string)=>value.split('\n').map(line=>delimiter+(literals.push(line)-1)+delimiter).join('\n');
  const entities=(value:string)=>Array.from(value,char=>'&#'+char.codePointAt(0)+';').join('');
  const literalHTML=(element:HTMLElement)=>{
    const clone=element.cloneNode(true) as HTMLElement,values:string[]=[];
    const preformatted=[...(clone.tagName==='PRE'?[clone]:[]),...clone.querySelectorAll('pre')];
    for(const pre of preformatted)if(!pre.querySelector('code')){const code=doc.createElement('code');code.append(...pre.childNodes);pre.append(code);}
    const walker=doc.createTreeWalker(clone,4);
    while(walker.nextNode()){const node=walker.currentNode;values.push((node.nodeValue??'').replace(/[&<>\r\n]/g,entities));node.nodeValue=delimiter+'html'+(values.length-1)+delimiter;}
    return clone.outerHTML.replace(new RegExp(delimiter+'html(\\d+)'+delimiter,'g'),(_,index)=>values[Number(index)]);
  };
  const escape=(value:string)=>value.replace(/\\/g,'\\\\').replace(/([`*_[\]<>])/g,'\\$1');
  const children=(node:Node)=>Array.from(node.childNodes).map(child=>convert(child)).join('');
  const destination=(value:string)=>`<${value.replace(/>/g,'%3E').replace(/\n|\r/g,'')}>`;
  function convert(node:Node):string {
    if(node.nodeType===3)return escape(node.textContent??'').replace(/[\t\r\n ]+/g,' ');
    if(node.nodeType!==1)return '';
    const el=node as HTMLElement,tag=el.tagName.toLowerCase();
    if(tag==='pre'){
      const code=el.querySelector('code'),text=(code??el).textContent??'';
      // Markdown fences add a final newline; HTML can preserve an empty or unterminated payload.
      if(!text.endsWith('\n'))return protectLines(literalHTML(el))+'\n\n';
      const language=code?.className.match(/language-([\w+-]+)/)?.[1]??'';
      const width=Math.max(3,...[...text.matchAll(/`+/g)].map(match=>match[0].length+1)),fence='`'.repeat(width);
      return protectLines(`${fence}${language}\n${text.slice(0,-1)}\n${fence}`)+'\n\n';
    }
    if(tag==='code'){
      const text=el.textContent??'';
      if(!text||/[\r\n]/.test(text))return '<code>'+entities(text)+'</code>';
      const width=Math.max(1,...[...text.matchAll(/`+/g)].map(match=>match[0].length+1));const fence='`'.repeat(width),pad=/^`|`$|^ .* $/.test(text)?' ':'';return `${fence}${pad}${text}${pad}${fence}`;
    }
    if(tag==='ul'||tag==='ol'){
      const start=Number(el.getAttribute('start'))||1;
      const rows=Array.from(el.children).filter(child=>child.tagName==='LI').map((li,index)=>{
        const prefix=tag==='ol'?`${start+index}. `:'- ';
        const content=children(li).trim().replace(/\n{3,}/g,'\n\n');
        return prefix+content.replace(/\n/g,'\n'+' '.repeat(prefix.length));
      });return '\n'+rows.join('\n')+'\n\n';
    }
    if(tag==='table'){
      const rows=Array.from(el.querySelectorAll('tr'));
      if(el.querySelector('[colspan],[rowspan],pre')||!rows.length)return protectLines(literalHTML(el))+'\n\n';
      const cells=rows.map(row=>Array.from(row.children).filter(cell=>/^(TD|TH)$/.test(cell.tagName)).map(cell=>children(cell).trim().replace(/\|/g,'\\|').replace(/\n+/g,'<br>')));
      const width=Math.max(...cells.map(row=>row.length));if(!width)return el.outerHTML+'\n\n';
      const line=(row:string[])=>'| '+Array.from({length:width},(_,index)=>row[index]??'').join(' | ')+' |';
      return [line(cells[0]),line(Array(width).fill('---')),...cells.slice(1).map(line)].join('\n')+'\n\n';
    }
    const content=children(el);
    if(/^h[1-6]$/.test(tag))return '#'.repeat(Number(tag[1]))+' '+content.trim()+'\n\n';
    if(['p','div','section','article'].includes(tag))return content.trim()+'\n\n';
    if(tag==='br')return '  \n';
    if(tag==='hr')return '---\n\n';
    if(tag==='blockquote')return content.trim().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if(tag==='strong'||tag==='b')return `**${content}**`;
    if(tag==='em'||tag==='i')return `*${content}*`;
    if(['del','s','strike'].includes(tag))return `~~${content}~~`;
    if(tag==='mark')return `==${content}==`;
    if(tag==='a'){const href=el.getAttribute('href');return href?`[${content}](${destination(href)}${title(el)})`:content;}
    if(tag==='img'){const src=el.getAttribute('src');return src?`![${escape(el.getAttribute('alt')??'')}](${destination(src)}${title(el)})`:escape(el.getAttribute('alt')??'');}
    if(['sub','sup','u','video','audio','svg','math'].includes(tag))return el.outerHTML;
    return content;
  }
  function title(el:HTMLElement){const value=el.getAttribute('title');return value?' "'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"':'';}
  return children(doc.body).trim().replace(/\n{3,}/g,'\n\n').replace(literalPattern,(_,index)=>literals[Number(index)]);
}
