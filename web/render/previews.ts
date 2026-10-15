import { markdownBlocks, sanitizeHTML } from './markdown.ts';
import { diagramSource } from './diagrams.ts';
import createDOMPurify from 'dompurify';
let mathPurifier:ReturnType<typeof createDOMPurify>|undefined;
function safeMathHTML(markup:string):string{
  mathPurifier??=createDOMPurify(window);
  return mathPurifier.sanitize(markup,{USE_PROFILES:{html:true,svg:true,mathMl:true},ADD_TAGS:['mjx-container','mjx-assistive-mml','use'],ADD_ATTR:['jax','display','focusable'],FORBID_TAGS:['script','object','embed','iframe'],FORBID_ATTR:['srcdoc']});
}

export type PreviewOptions={dark?:boolean;numbering?:'none'|'ams'|'all';physics?:boolean;documentId?:string;documentSource?:string;sourceOffset?:number};
export type MathConversionOptions=PreviewOptions & {display?:boolean;mathIndex?:number};
type Expression={text:string;kind:string;from:number};
type MathOutput={svg:string;mathml:string;error?:string};
const scriptLoads=new Map<string,Promise<void>>();
const svgCache=new Map<string,string>();
const documentCache=new Map<string,{expressions:Expression[];outputs:MathOutput[];size:number}>();
let documentCacheSize=0;
let cacheGeneration=0;
let mathReady:Promise<any>|undefined;
let mathPackages:string[]=[];
let engineOptions='';
let mathSerial=Promise.resolve();
let diagramReady:Promise<any>|undefined;
let diagramSerial=Promise.resolve();
let sequence=0;

function loadScript(path:string):Promise<void>{
  if(scriptLoads.has(path))return scriptLoads.get(path)!;
  const promise=new Promise<void>((resolve,reject)=>{
    const script=document.createElement('script');script.src=new URL(path,document.baseURI).href;
    script.onload=()=>resolve();script.onerror=()=>reject(new Error(`렌더링 자원을 불러오지 못했습니다: ${path}`));
    document.head.append(script);
  });scriptLoads.set(path,promise);return promise;
}

function serialMath<T>(work:()=>Promise<T>):Promise<T>{
  const done=mathSerial.then(work);mathSerial=done.then(()=>{},()=>{});return done;
}

async function mathEngine(options:PreviewOptions):Promise<any>{
  if(!mathReady){
    const root=new URL('./vendor/mathjax/',document.baseURI).href.replace(/\/$/,'');
    (window as any).MathJax={loader:{paths:{mathjax:root}},
      tex:{tags:'none'},svg:{fontCache:'local'},startup:{typeset:false},
      options:{enableMenu:false,enableExplorer:false,enableEnrichment:false,
        menuOptions:{settings:{enrich:false,speech:false,braille:false}}}};
    mathReady=loadScript('./vendor/mathjax/tex-svg-full.js').then(async()=>{
      const math=(window as any).MathJax;await math.startup.promise;
      mathPackages=[...math.startup.input[0].options.packages].filter((name:string)=>name!=='physics');
      return math;
    });
  }
  const math=await mathReady;
  const key=JSON.stringify([options.numbering||'none',!!options.physics]);
  if(engineOptions!==key){
    if(options.physics)await math.loader.load('[tex]/physics');
    math.config.tex.tags=options.numbering||'none';
    math.config.tex.packages=[...mathPackages,...(options.physics?['physics']:[])];
    engineOptions=key;
  }
  // Recreate the input jax as well as tags: document-defined macros must not leak.
  math.typesetClear();math.startup.getComponents();math.texReset();
  return math;
}

function mathNodes(element:HTMLElement):HTMLElement[]{
  return [...(element.matches('[data-math]')?[element]:[]),...element.querySelectorAll<HTMLElement>('[data-math]')];
}

function documentExpressions(source:string):Expression[]{
  const expressions:Expression[]=[];
  for(const block of markdownBlocks(source)){
    const element=document.createElement('div');element.innerHTML=block.html;
    for(const node of mathNodes(element))expressions.push({text:node.textContent||'',kind:node.dataset.math||'inline',from:block.from});
  }
  return expressions;
}

async function renderMath(expressions:Expression[],options:PreviewOptions):Promise<MathOutput[]>{
  const math=await mathEngine(options);
  const stage=document.createElement('div');
  stage.setAttribute('aria-hidden','true');
  stage.style.cssText='position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;font-size:16px;width:100%;';
  const slots=expressions.map(expression=>{
    const node=document.createElement('div');
    node.textContent=expression.kind==='block'?`\\[${expression.text}\\]`:`\\(${expression.text}\\)`;
    stage.append(node);return node;
  });
  document.body.append(stage);
  try{
    // The document finder/compile pass handles forward references and tag retries.
    await math.typesetPromise([stage]);
    return slots.map(node=>{
      const error=node.querySelector('[data-mml-node="merror"],merror');
      const message=error?.getAttribute('data-mjx-error')||error?.textContent||undefined;
      const item=math.startup.document.getMathItemsWithin([node])[0];
      if(!item||!node.querySelector('mjx-container'))return {svg:'',mathml:'',error:'수식을 표시하지 못했습니다.'};
      return {svg:node.innerHTML,mathml:math.startup.toMML(item.root),error:message};
    });
  }finally{math.typesetClear();stage.remove();}
}

async function mathContext(expressions:Expression[],options:PreviewOptions){
  const key=JSON.stringify([options.documentId||'',options.documentSource??expressions,options.numbering||'none',!!options.physics]);
  const cached=documentCache.get(key);
  if(cached){documentCache.delete(key);documentCache.set(key,cached);return cached;}
  const generation=cacheGeneration;
  const outputs=await renderMath(expressions,options);
  const size=key.length+outputs.reduce((sum,item)=>sum+item.svg.length+item.mathml.length,0);
  const context={expressions,outputs,size};
  if(generation===cacheGeneration&&size<=2_000_000){
    while(documentCache.size>=12||documentCacheSize+size>2_000_000){
      const oldest=documentCache.keys().next().value!;
      documentCacheSize-=documentCache.get(oldest)!.size;documentCache.delete(oldest);
    }
    documentCache.set(key,context);documentCacheSize+=size;
  }
  return context;
}

function expressionIndex(expressions:Expression[],text:string,kind:string,offset:number,start=0):number{
  return expressions.findIndex((entry,index)=>index>=start&&entry.from>=offset&&entry.text===text&&entry.kind===kind);
}

export async function convertMath(tex:string,format:'svg'|'mathml',options:MathConversionOptions={}):Promise<string>{
  return serialMath(async()=>{
    const kind=options.display===false?'inline':'block';
    const expressions=options.documentSource!==undefined?documentExpressions(options.documentSource):[{text:tex,kind,from:0}];
    const context=await mathContext(expressions,options);
    const index=expressionIndex(expressions,tex,kind,options.documentSource!==undefined?options.sourceOffset??0:0,options.mathIndex??0);
    if(index<0)throw new Error('문서에서 복사할 수식을 찾지 못했습니다.');
    const output=context.outputs[index];
    if(output.error)throw new Error(output.error);
    if(format==='mathml')return safeMathHTML(output.mathml);
    const container=document.createElement('div');container.innerHTML=safeMathHTML(output.svg);
    return container.querySelector('svg')!.outerHTML;
  });
}

async function diagramEngine(options:PreviewOptions):Promise<any>{
  if(!diagramReady)diagramReady=loadScript('./vendor/mermaid/mermaid.min.js').then(()=>{
    const bundle=(window as any).mermaid||(window as any).__esbuild_esm_mermaid_nm?.mermaid;
    const mermaid=bundle?.default||bundle;
    if(!mermaid?.initialize)throw new Error('도식 렌더러를 초기화할 수 없습니다.');
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:options.dark?'dark':'default',
      fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif'});return mermaid;
  });return diagramReady;
}

export async function typesetPreviews(element:HTMLElement,options:PreviewOptions={}):Promise<void>{
  const jobs:Promise<void>[]=[];
  const nodes=mathNodes(element);
  const captures=nodes.map(node=>{
    const text=node.dataset.source??node.textContent??'';node.dataset.source=text;
    const jobId=String(++sequence);node.dataset.renderJob=jobId;
    return {node,text,kind:node.dataset.math||'inline',jobId};
  });
  if(captures.length){
    const expressions=options.documentSource!==undefined?documentExpressions(options.documentSource):captures.map(entry=>({text:entry.text,kind:entry.kind,from:0}));
    const offset=options.documentSource!==undefined?options.sourceOffset??Number(element.dataset.sourceOffset||0):0;
    jobs.push(serialMath(async()=>{
      try{
        const context=await mathContext(expressions,options);let start=0;
        for(const entry of captures){
          const index=expressionIndex(context.expressions,entry.text,entry.kind,offset,start);start=index+1;
          if(entry.node.dataset.renderJob!==entry.jobId)continue;
          const output=context.outputs[index];
          if(!output||output.error){
            entry.node.classList.add('preview-error');entry.node.textContent=`${output?.error||'문서에서 수식을 찾지 못했습니다.'}\n\n${entry.text}`;
          }else{entry.node.innerHTML=safeMathHTML(output.svg);entry.node.classList.remove('preview-error');}
        }
      }catch(error){
        for(const entry of captures)if(entry.node.dataset.renderJob===entry.jobId){
          entry.node.classList.add('preview-error');entry.node.textContent=`${error instanceof Error?error.message:'표시 실패'}\n\n${entry.text}`;
        }
      }
    }));
  }
  for(const node of element.querySelectorAll<HTMLElement>('[data-diagram]')){
    const text=node.dataset.source||node.textContent||'';node.dataset.source=text;
    const kind=node.dataset.diagram||'';
    const key=JSON.stringify([kind,text,!!options.dark]);
    const jobId=String(++sequence);node.dataset.renderJob=jobId;
    const cached=svgCache.get(key);
    if(cached){node.innerHTML=cached;node.classList.remove('preview-error');continue;}
    const job=(async()=>{
      try{
        const source=diagramSource(kind,text);
        const mermaid=await diagramEngine(options);let svg='';
        const render=async()=>{
          mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:options.dark?'dark':'default',fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif'});
          const stage=document.createElement('div');stage.style.cssText='position:absolute;left:-100000px;top:0;width:100%;visibility:hidden';
          document.body.append(stage);
          try{svg=(await mermaid.render(`mori-diagram-${jobId}`,source,stage)).svg;}
          finally{stage.remove();}
        };
        const done=diagramSerial.then(render);diagramSerial=done.catch(()=>{});await done;
        if(svgCache.size>=200)svgCache.delete(svgCache.keys().next().value!);
        svgCache.set(key,svg);
        if(node.dataset.renderJob===jobId){node.innerHTML=svg;node.classList.remove('preview-error');}
      }catch(error){
        if(node.dataset.renderJob===jobId){node.classList.add('preview-error');node.textContent=`${error instanceof Error?error.message:'표시 실패'}\n\n${text}`;}
      }
    })();jobs.push(job);
  }
  await Promise.all(jobs);
}

export function clearPreviewCache():void{
  cacheGeneration++;svgCache.clear();documentCache.clear();documentCacheSize=0;
}
