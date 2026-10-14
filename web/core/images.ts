import { parser } from '@lezer/markdown';
import MarkdownIt from 'markdown-it';
import { frontMatterRange } from './source.ts';

const utils = new MarkdownIt().utils;
export interface ImageReference {
  from: number; to: number; urlFrom: number; urlTo: number; url: string;
  kind: 'markdown' | 'html'; quote: string; alt: string; title?: string; attributes?: string[];
}
export interface ImageSelection { from: number; to: number }
const selected = (image: {from:number;to:number}, range?: ImageSelection) => !range || (range.from === range.to ? image.from <= range.from && range.from < image.to : image.from < range.to && image.to > range.from);

/** Syntax tree boundaries keep code, comments and unrelated links out of edit plans. */
export function discoverImages(source: string): ImageReference[] {
  const images: ImageReference[] = [], front = frontMatterRange(source);
  parser.parse(source).iterate({ enter(node) {
    if (front && node.from < front.to && node.name !== 'Document') return false;
    if (['InlineCode','FencedCode','CodeBlock'].includes(node.name)) return false;
    if (node.name === 'Image') {
      const url = node.node.getChild('URL');
      if (!url) return false;
      const raw = source.slice(url.from,url.to), angle = raw.startsWith('<') && raw.endsWith('>');
      const endLabel = node.node.getChildren('LinkMark').find(mark => source.slice(mark.from,mark.to) === ']');
      const title = node.node.getChild('LinkTitle');
      images.push({from:node.from,to:node.to,urlFrom:url.from + Number(angle),urlTo:url.to - Number(angle),url:utils.unescapeAll(angle ? raw.slice(1,-1) : raw),kind:'markdown',quote:angle ? '<' : '',alt:utils.unescapeAll(source.slice(node.from+2,endLabel?.from ?? node.from+2)),...(title ? {title:utils.unescapeAll(source.slice(title.from+1,title.to-1))} : {})});
      return false;
    }
    if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
      const text = source.slice(node.from,node.to); let blocked: string[] = [];
      for (const tag of text.matchAll(/<!--[\s\S]*?(?:-->|$)|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g)) {
        if (tag[0].startsWith('<!--')) continue;
        const name = /^<\/?([\w-]+)/.exec(tag[0])![1].toLowerCase(), closing = tag[0].startsWith('</');
        if (['pre','code','script','style','textarea'].includes(name)) { if (closing) blocked.pop(); else blocked.push(name); continue; }
        if (blocked.length || name !== 'img' || closing) continue;
        const attributes = [...tag[0].matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].slice(1);
        const src = attributes.filter(attr => attr[1].toLowerCase() === 'src');
        if (src.length !== 1) continue;
        const attr = src[0], value = attr[2] ?? attr[3] ?? attr[4]; if (value === undefined) continue;
        const quote = attr[2] !== undefined ? '"' : attr[3] !== undefined ? "'" : '';
        const offset = attr[0].indexOf('=') + 1, afterEqual = attr[0].slice(offset), leading = afterEqual.length - afterEqual.trimStart().length;
        const from = node.from + tag.index!, urlFrom = from + attr.index! + offset + leading + Number(!!quote);
        const get = (name:string) => { const a = attributes.find(a=>a[1].toLowerCase()===name); return a ? utils.unescapeAll(a[2] ?? a[3] ?? a[4] ?? '') : undefined; };
        images.push({from,to:from+tag[0].length,urlFrom,urlTo:urlFrom+value.length,url:utils.unescapeAll(value),kind:'html',quote,alt:get('alt') ?? '',title:get('title'),attributes:attributes.map(a=>a[1].toLowerCase())});
      }
      return false;
    }
  }});
  return images.sort((a,b)=>a.from-b.from);
}

function assertDirectImages(source:string, selection?:ImageSelection) {
  const front = frontMatterRange(source);
  parser.parse(source).iterate({enter(node){
    if(front && node.from < front.to && node.name !== 'Document') return false;
    if(['InlineCode','FencedCode','CodeBlock'].includes(node.name)) return false;
    if(node.name==='Image' && !node.node.getChild('URL') && selected(node,selection)) throw new Error('Unsupported reference-style image. Convert it to an inline image URL first.');
  }});
}
export function resolveImageReferences(source:string):string{
  const definitions=new Map<string,{url:string;title?:string}>(),images:{from:number;to:number;label:string;alt:string}[]=[],front=frontMatterRange(source);
  const normalize=(label:string)=>utils.normalizeReference(utils.unescapeAll(label));
  parser.parse(source).iterate({enter(node){
    if(front && node.from<front.to && node.name!=='Document')return false;
    if(['InlineCode','FencedCode','CodeBlock'].includes(node.name))return false;
    if(node.name==='LinkReference'){
      const label=node.node.getChild('LinkLabel'),url=node.node.getChild('URL'),title=node.node.getChild('LinkTitle');
      if(label && url){const key=normalize(source.slice(label.from+1,label.to-1)),raw=source.slice(url.from,url.to);if(!definitions.has(key))definitions.set(key,{url:utils.unescapeAll(raw.startsWith('<')?raw.slice(1,-1):raw),...(title?{title:utils.unescapeAll(source.slice(title.from+1,title.to-1))}:{})});}return false;
    }
    if(node.name==='Image' && !node.node.getChild('URL')){
      const close=node.node.getChildren('LinkMark').find(mark=>source.slice(mark.from,mark.to)===']'),label=node.node.getChild('LinkLabel');
      if(close){const alt=utils.unescapeAll(source.slice(node.from+2,close.from));images.push({from:node.from,to:node.to,alt,label:normalize(label?source.slice(label.from+1,label.to-1)||alt:alt)});}return false;
    }
  }});
  return editRanges(source,images.flatMap(image=>{const target=definitions.get(image.label);if(!target)return [];return [{from:image.from,to:image.to,text:`![${image.alt.replace(/[\\[\]]/g,'\\$&')}](${encodeURL(target.url)}${target.title!==undefined?` "${target.title.replace(/[\\"]/g,'\\$&')}"`:''})`}];}));
}
function isLocal(url:string):boolean { return !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(url) || /^file:/i.test(url); }
export function localImageURL(url:string,root?:string):URL {
  if (!root?.startsWith('/')) throw new Error('Save the document or import an image first to establish its image root.');
  const base=root.replace(/\/$/,'').split('/').map(encodeURIComponent).join('/');
  const parsed = new URL(url, `file://${base}/`);
  if(parsed.protocol !== 'file:' || (parsed.hostname && parsed.hostname !== 'localhost')) throw new Error(`Unsupported local image URL: ${url}`);
  return parsed;
}
export function localImagePath(url:string, root?:string):string {
  const parsed=localImageURL(url,root);
  const path = decodeURIComponent(parsed.pathname);
  if(path.includes('\0')) throw new Error('Image paths cannot contain NUL.');
  return path;
}
export function localImagePlan(source:string, root?:string, selection?:ImageSelection) {
  assertDirectImages(source,selection);
  const images = discoverImages(source).filter(image=>selected(image,selection) && isLocal(image.url));
  const imagePaths = images.map(image=>localImagePath(image.url,root));
  return {images,imagePaths,paths:[...new Set(imagePaths)]};
}
export function parseUploaderArguments(source:string):string[] {
  let value:unknown; try { value=JSON.parse(source); } catch { throw new Error('Uploader arguments must be a JSON string array.'); }
  if(!Array.isArray(value) || value.some(arg=>typeof arg!=='string')) throw new Error('Uploader arguments must be a JSON string array.');
  if(value.some(arg=>arg.includes('\0'))) throw new Error('Uploader arguments cannot contain NUL.');
  return value;
}
export function parseUploadOutput(output:string, count:number):string[] {
  const text=output.trim(); let value:unknown;
  if(text.startsWith('[') || text.startsWith('{')) {
    try {value=JSON.parse(text);} catch {throw new Error('Uploader returned invalid JSON.');}
    if(value && !Array.isArray(value) && typeof value==='object') {
      const object=value as Record<string,unknown>;
      if(object.error || (object.errors && (!Array.isArray(object.errors) || object.errors.length)) || object.success===false) throw new Error('Uploader reported a partial failure; no image links were replaced.');
      value=object.urls;
    }
  } else value=text ? text.split(/\r?\n/).map(line=>line.trim()) : [];
  if(!Array.isArray(value) || value.length!==count) throw new Error(`Uploader URL count must match ${count} distinct local images; no links were replaced.`);
  return value.map(url=>{
    if(typeof url!=='string' || !/^https?:\/\//i.test(url) || /[\s\u0000-\u001f]/.test(url)) throw new Error('Uploader must return one valid HTTP(S) URL per image.');
    try { if(!new URL(url).hostname) throw new Error(); } catch { throw new Error('Uploader returned an invalid URL.'); }
    return url;
  });
}
function encodeURL(url:string):string {return url.replace(/[\s<>"'`\\()[\]]/g,char=>encodeURIComponent(char).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`));}
function editRanges(source:string, edits:{from:number;to:number;text:string}[]):string {
  let end=source.length; for(const edit of edits.sort((a,b)=>b.from-a.from)) { if(edit.to>end) throw new Error('Overlapping image edits are unsupported.'); source=source.slice(0,edit.from)+edit.text+source.slice(edit.to); end=edit.from; } return source;
}
export function replaceImageURLs(source:string, images:ImageReference[], urls:string[], expectedSource=source):string {
  if(source!==expectedSource) throw new Error('Document source changed; no image links were replaced.');
  if(images.length!==urls.length) throw new Error('Image replacement count mismatch.');
  return editRanges(source,images.map((image,index)=>({from:image.urlFrom,to:image.urlTo,text:image.kind==='html' ? utils.escapeHtml(encodeURL(urls[index])) : encodeURL(urls[index])})));
}
export function convertImageSyntax(source:string, target:'markdown'|'html', selection?:ImageSelection):string {
  assertDirectImages(source,selection);
  return editRanges(source,discoverImages(source).filter(image=>selected(image,selection) && image.kind!==target).map(image=>{
    if(target==='markdown' && image.attributes?.some(name=>!['src','alt','title'].includes(name))) throw new Error('Cannot preserve HTML image attributes in Markdown. Keep HTML syntax for this image.');
    const url=encodeURL(image.url), title=image.title;
    const text=target==='html' ? `<img src="${utils.escapeHtml(url)}" alt="${utils.escapeHtml(image.alt)}"${title!==undefined ? ` title="${utils.escapeHtml(title)}"` : ''}>` : `![${image.alt.replace(/[\\[\]]/g,'\\$&')}](${url}${title!==undefined ? ` "${title.replace(/[\\"]/g,'\\$&')}"` : ''})`;
    return {from:image.from,to:image.to,text};
  }));
}
export function imageURLForPath(path:string, root:string):string {
  const base=root.split('/').filter(Boolean), parts=path.split('/').filter(Boolean); let common=0;
  while(common<base.length && common<parts.length && base[common]===parts[common]) common++;
  return [...base.slice(common).map(()=>'..'),...parts.slice(common)].map(part=>encodeURIComponent(part).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}
export function relativeImageURLs(source:string, root:string, selection?:ImageSelection):string {
  const plan=localImagePlan(source,root,selection);
  return replaceImageURLs(source,plan.images,plan.imagePaths.map((path,index)=>{const url=localImageURL(plan.images[index].url,root);return imageURLForPath(path,root)+url.search+url.hash;}));
}
export interface UploadRequest {jobId:string;executable:string;arguments:string[];directory:string;timeout:number;maxOutputBytes:number}
export interface UploadResult {exitCode:number;stdout?:string;stderr?:string;cancelled?:boolean;timedOut?:boolean;outputTruncated?:boolean}
export async function uploadImages(options:{source:string;root?:string;selection?:ImageSelection;executable:string;argumentsJSON:string;jobId:string;isCurrent:()=>boolean;run:(request:UploadRequest)=>Promise<UploadResult>}):Promise<string> {
  if(!options.executable?.trim()) throw new Error('Configure a custom image uploader executable in Settings first.');
  if(!options.executable.startsWith('/') || options.executable.includes('\0')) throw new Error('Uploader executable must be an absolute path without NUL.');
  const args=parseUploaderArguments(options.argumentsJSON), plan=localImagePlan(options.source,options.root,options.selection);
  if(!plan.paths.length) throw new Error('No local images in the requested selection or document.');
  if(!options.isCurrent()) throw new Error('Document changed; upload was not started.');
  const result=await options.run({jobId:options.jobId,executable:options.executable,arguments:[...args,...plan.paths],directory:options.root!,timeout:120,maxOutputBytes:1_048_576});
  if(!result || result.exitCode!==0 || result.cancelled || result.timedOut || result.outputTruncated) throw new Error(`Image upload ${result?.cancelled?'cancelled':result?.timedOut?'timed out':result?.outputTruncated?'output truncated':'failed'}; no links were replaced. ${result?.stderr ?? ''}`);
  const urls=parseUploadOutput(result.stdout ?? '',plan.paths.length);
  if(!options.isCurrent()) throw new Error('Document changed during upload; no image links were replaced. Uploaded files may exist at the destination.');
  const mapping=new Map(plan.paths.map((path,index)=>[path,urls[index]]));
  return replaceImageURLs(options.source,plan.images,plan.imagePaths.map(path=>mapping.get(path)!));
}

export type ImageFileOperation = 'copy'|'move'|'rename'|'trash';
export interface ImageFilePlan { files:{path:string;destination?:string}[];images:ImageReference[];imagePaths:string[];root:string;operation:ImageFileOperation }
function absoluteFilePath(path:string):string {
  if(!path.startsWith('/') || path.includes('\0'))throw new Error('Image destination must be an absolute path without NUL.');
  const parts:string[]=[];for(const part of path.split('/')){if(!part || part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}return '/'+parts.join('/');
}
export function planImageFileOperation(source:string,root:string,operation:ImageFileOperation,destination?:string,selection?:ImageSelection):ImageFilePlan {
  root=absoluteFilePath(root);const chosen=localImagePlan(source,root,selection);
  if(!chosen.paths.length)throw new Error('No local image at the selection or in this document.');
  if((operation==='rename'||operation==='trash') && chosen.paths.length!==1)throw new Error('Select exactly one local image file.');
  const all=localImagePlan(source,root),images=all.images.filter((_,index)=>chosen.paths.includes(all.imagePaths[index])),imagePaths=all.imagePaths.filter(path=>chosen.paths.includes(path));
  const folder=destination===undefined?undefined:absoluteFilePath(destination);
  if(operation!=='trash' && !folder)throw new Error('Choose an image destination.');
  if(folder && !(root==='/' ? folder.startsWith('/') && folder!=='/' : (folder===root && operation!=='rename') || folder.startsWith(root+'/')))throw new Error('Image destination must be inside the document image root so its relative links remain readable.');
  const files=chosen.paths.map(path=>({path,...(folder?{destination:operation==='rename'?folder:folder+'/'+path.split('/').at(-1)!}:{})}));
  if(files.some(file=>file.path===file.destination))throw new Error('Choose a destination different from the original image path.');
  const targets=files.flatMap(file=>file.destination?[file.destination.normalize('NFC').toLowerCase()]:[]);
  if(new Set(targets).size!==targets.length)throw new Error('Image filename collision within the requested batch. Rename the duplicate files first.');
  return {files,images,imagePaths,root,operation};
}
export async function manageImageFiles(options:{source:string;root:string;operation:ImageFileOperation;destination?:string;selection?:ImageSelection;isCurrent:()=>boolean;call:(method:string,args:Record<string,unknown>)=>Promise<unknown>}):Promise<string> {
  const plan=planImageFileOperation(options.source,options.root,options.operation,options.destination,options.selection);
  const current=()=>{if(!options.isCurrent())throw new Error('Document or selection changed; image file operations were rolled back.');};
  current();
  const directories=[...new Set(plan.files.flatMap(file=>file.destination?[file.destination.slice(0,file.destination.lastIndexOf('/'))||'/']:[]))];
  for(const path of directories){
    const entries=await options.call('listDirectory',{path});if(!Array.isArray(entries))throw new Error('Native directory listing is unavailable. No image files were changed.');
    const occupied=new Set(entries.map((entry:any)=>String(entry.name).normalize('NFC').toLowerCase()));
    const conflict=plan.files.find(file=>file.destination && (file.destination.slice(0,file.destination.lastIndexOf('/'))||'/')===path && occupied.has(file.destination.split('/').at(-1)!.normalize('NFC').toLowerCase()));
    if(conflict)throw new Error(`Image destination collision: ${conflict.destination}. No files were overwritten.`);
  }
  const completed:{path:string;destination:string}[]=[];
  try {
    for(const file of plan.files){
      current();const result=await options.call('manageFile',{operation:plan.operation,path:file.path,...(file.destination?{destination:file.destination}:{})});
      const destination=typeof result==='string'?result:file.destination;
      if(destination)completed.push({path:file.path,destination});
      if(typeof result!=='string' || (!file.destination && !result) || (file.destination && result!==file.destination))throw new Error('Native image operation returned an invalid destination.');
      current();
    }
    if(plan.operation==='trash')return editRanges(options.source,plan.images.map(image=>({from:image.from,to:image.to,text:''})));
    const mapping=new Map(completed.map(file=>[file.path,imageURLForPath(file.destination,plan.root)]));
    return replaceImageURLs(options.source,plan.images,plan.imagePaths.map((path,index)=>{const url=localImageURL(plan.images[index].url,plan.root);return mapping.get(path)!+url.search+url.hash;}));
  } catch(error){
    const failures:string[]=[];
    for(const file of completed.reverse())try{await options.call('manageFile',plan.operation==='copy'?{operation:'trash',path:file.destination}:{operation:'move',path:file.destination,destination:file.path});}catch{failures.push(`${file.destination} → ${file.path}`);}
    if(failures.length)throw new Error(`${error instanceof Error?error.message:String(error)} Rollback incomplete: ${failures.join(', ')}. No source links were replaced.`);
    throw error;
  }
}
