/** Translate the compact legacy diagram grammars into the local Mermaid renderer. */
export function diagramSource(kind:string,source:string):string {
  if(kind==='mermaid')return source;
  if(kind==='sequence'){
    if(/^\s*sequenceDiagram\b/.test(source))return source;
    let title='';const lines=source.split(/\r\n|\n|\r/).map(line=>{
      const heading=/^\s*Title:\s*(.*)$/i.exec(line);if(heading){title=heading[1];return '';}
      if(/^\s*#/.test(line))return line.replace(/^\s*#/,'%%');
      return line.replace(/(--?>)(?!>)/g,'$1>');
    }).filter(line=>line.trim());
    return (title?`---\ntitle: ${JSON.stringify(title)}\n---\n`:'')+'sequenceDiagram\n'+lines.join('\n');
  }
  if(kind!=='flow')throw new Error(`Unsupported diagram grammar: ${kind}`);
  if(/^\s*(?:graph|flowchart)\b/.test(source))return source;
  const nodes=new Map<string,{shape:string;label:string}>(),edges:{line:string;index:number}[]=[];
  for(const [index,line] of source.split(/\r\n|\n|\r/).entries()){
    if(!line.trim()||/^\s*(?:#|%%)/.test(line))continue;
    const declaration=/^\s*([\w]+)\s*=>\s*(start|end|operation|inputoutput|condition|subroutine|parallel)\s*:\s*(.*)$/.exec(line);
    if(declaration){if(nodes.has(declaration[1]))throw new Error(`Duplicate flow node at line ${index+1}.`);nodes.set(declaration[1],{shape:declaration[2],label:declaration[3].split(/(?<!\\)\|/)[0].trim().replace(/\\\|/g,'|')});}
    else edges.push({line,index:index+1});
  }
  const result=['flowchart TD'],id=(value:string)=>'n_'+value;
  for(const [name,node] of nodes){const label=JSON.stringify(node.label),shapes:Record<string,string>={start:`([${label}])`,end:`([${label}])`,operation:`[${label}]`,inputoutput:`[/${label}/]`,condition:`{${label}}`,subroutine:`[[${label}]]`,parallel:`{{${label}}}`};result.push(`${id(name)}${shapes[node.shape]}`);}
  for(const edge of edges){
    const parts=edge.line.split('->').map(part=>/^\s*(\w+)(?:\(([^)]*)\))?\s*$/.exec(part));
    if(parts.length<2 || parts.some(part=>!part||!nodes.has(part[1])))throw new Error(`Unsupported flow syntax or unknown node at line ${edge.index}.`);
    for(let index=0;index<parts.length-1;index++){const from=parts[index]!,to=parts[index+1]!,label=from[2]?.split(',')[0].trim(),branch=label&&!['left','right','top','bottom'].includes(label)?`|${JSON.stringify(label)}| `:'';result.push(`${id(from[1])} -->${branch?branch:' '}${id(to[1])}`);}
  }
  if(!nodes.size)throw new Error('The flow diagram has no node declarations.');return result.join('\n');
}
