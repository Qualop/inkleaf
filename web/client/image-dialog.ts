import MarkdownIt from 'markdown-it';
import { parser } from '@lezer/markdown';
import { discoverImages, localImagePath } from '../core/images.ts';
import { modal, button, field, input } from './dialog.ts';

export interface ImageDialogOptions {
  source:string;selection:{from:number;to:number};isCurrent:()=>boolean;
  apply:(source:string,selection:{from:number;to:number})=>void;
  assetRoot?:string;readAsset?:(path:string,root:string)=>Promise<{type:string;base64:string}>;
}
type Property = 'alt'|'title'|'width'|'height';
type Edit = {from:number;to:number;text:string};
type Attribute = {name:string;from:number;to:number;valueFrom?:number;valueTo?:number;quote:string;value:string};
const utils=new MarkdownIt().utils;
const escapeHTML=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const decodeHTML=(value:string)=>value.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,entity=>utils.unescapeAll(entity));
function attributes(tag:string):Attribute[] {
  return [...tag.matchAll(/(\s+)([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(match=>{
    const quoted=match[3]!==undefined?'"':match[4]!==undefined?"'":'',value=match[3]??match[4]??match[5];
    const equal=match[0].indexOf('='),tail=equal>=0?match[0].slice(equal+1):'',leading=tail.length-tail.trimStart().length;
    const valueFrom=value!==undefined?match.index!+equal+1+leading+Number(!!quoted):undefined;
    return {name:match[2],from:match.index!,to:match.index!+match[0].length,valueFrom,valueTo:valueFrom===undefined?undefined:valueFrom+value!.length,quote:quoted,value:decodeHTML(value ?? '')};
  });
}
function edited(source:string,edits:Edit[]):string {
  for(const edit of edits.sort((a,b)=>b.from-a.from))source=source.slice(0,edit.from)+edit.text+source.slice(edit.to);return source;
}
function dimension(value:string,name:string):string {
  value=value.trim();if(!value)return '';
  if(!/^\d+$/.test(value) || Number(value)<1 || Number(value)>32768)throw new Error(`${name} must be whole pixels from 1 to 32768, or blank for natural size.`);
  return String(Number(value));
}

export function openImageDialog(root:HTMLElement,options:ImageDialogOptions):void {
  const images=discoverImages(options.source).filter(image=>options.selection.from===options.selection.to?image.from<=options.selection.from && options.selection.from<image.to:image.from<options.selection.to && image.to>options.selection.from);
  const dialog=modal(root,'Image Properties'),doc=root.ownerDocument;
  if(images.length!==1){dialog.body.textContent='Select exactly one Markdown or HTML image with an inline URL, outside code examples.';return;}
  if(!options.isCurrent()){dialog.body.textContent='The document changed. Reopen image properties from its current source.';return;}
  const image=images[0],raw=options.source.slice(image.from,image.to),attrs=image.kind==='html'?attributes(raw):[];
  const initial:Record<Property,string>={alt:image.kind==='html'?attrs.find(attr=>attr.name.toLowerCase()==='alt')?.value ?? '':image.alt,title:image.kind==='html'?attrs.find(attr=>attr.name.toLowerCase()==='title')?.value ?? '':image.title ?? '',width:attrs.find(attr=>attr.name.toLowerCase()==='width')?.value ?? '',height:attrs.find(attr=>attr.name.toLowerCase()==='height')?.value ?? ''};
  const controls={} as Record<Property,HTMLInputElement>;
  for(const [name,label] of [['alt','Alternative text'],['title','Title'],['width','Width (pixels)'],['height','Height (pixels)']] as [Property,string][]){const control=input('text',initial[name]);control.dataset.imageProperty=name;control.setAttribute('aria-label',label);if(name==='width'||name==='height')control.inputMode='numeric';controls[name]=control;initial[name]=control.value;dialog.body.append(field(label,control));}
  const conversion=doc.createElement('p');conversion.setAttribute('data-image-conversion','');conversion.textContent='Markdown image dimensions require HTML: Apply converts only this image to an <img> tag with width and height attributes.';dialog.body.append(conversion);
  const error=doc.createElement('p');error.setAttribute('data-image-error','');error.setAttribute('role','alert');dialog.body.append(error);
  const pane=doc.createElement('div');pane.style.overflow='auto';pane.style.maxHeight='260px';pane.setAttribute('aria-label','Image preview');
  const preview=doc.createElement('img');preview.setAttribute('data-image-preview','');preview.alt=initial.alt;preview.style.display='block';preview.style.transformOrigin='top left';pane.append(preview);
  const status=doc.createElement('p');status.setAttribute('data-image-preview-status','');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='Loading preview…';
  const tools=doc.createElement('div');tools.setAttribute('role','group');tools.setAttribute('aria-label','Preview zoom controls');
  const fit=button('Fit'),out=button('Zoom Out'),inside=button('Zoom In'),zoom=doc.createElement('span');fit.setAttribute('data-image-fit','');out.setAttribute('data-image-zoom-out','');inside.setAttribute('data-image-zoom-in','');zoom.setAttribute('data-image-zoom-value','');tools.append(fit,out,inside,zoom);dialog.body.append(pane,tools,status);
  let scale=100,fitting=true,closed=false,applied=false;
  const live=()=>!closed && dialog.element.isConnected;
  dialog.element.addEventListener('mori-dismiss',()=>{closed=true;});
  const refreshPreview=()=>{
    conversion.hidden=image.kind!=='markdown' || !(controls.width.value.trim() || controls.height.value.trim());preview.alt=controls.alt.value;preview.title=controls.title.value;
    for(const key of ['width','height'] as const){let value='';try{value=dimension(controls[key].value,key);}catch{}preview.style[key]=value?`${value}px`:'auto';}
    preview.style.maxWidth=fitting?'100%':'none';preview.style.maxHeight=fitting?'240px':'none';preview.style.transform=`scale(${fitting?1:scale/100})`;zoom.textContent=fitting?'Fit':`${scale}%`;out.disabled=!fitting && scale<=25;inside.disabled=!fitting && scale>=400;
  };
  for(const control of Object.values(controls))control.addEventListener('input',()=>{error.textContent='';refreshPreview();});
  fit.addEventListener('click',()=>{fitting=true;scale=100;refreshPreview();});inside.addEventListener('click',()=>{fitting=false;scale=Math.min(400,scale+25);refreshPreview();});out.addEventListener('click',()=>{fitting=false;scale=Math.max(25,scale-25);refreshPreview();});
  preview.addEventListener('load',()=>{if(live())status.textContent='Image preview loaded.';});preview.addEventListener('error',()=>{if(live())status.textContent='Image preview could not be loaded. You can still edit its source properties.';});refreshPreview();

  const apply=button('Apply Image Properties');apply.setAttribute('data-image-apply','');dialog.footer.append(apply);
  apply.addEventListener('click',()=>{
    if(applied || !live())return;
    try{
      if(!options.isCurrent())throw new Error('The document or selection changed. Reopen image properties before applying.');
      const values:Record<Property,string>={alt:controls.alt.value,title:controls.title.value,width:controls.width.value,height:controls.height.value};
      const changed=(name:Property)=>values[name]!==initial[name];
      for(const name of ['width','height'] as const)if(changed(name) || image.kind==='markdown')values[name]=dimension(values[name],name);
      let replacement=raw;
      if(image.kind==='markdown' && (values.width || values.height))replacement=`<img src="${escapeHTML(image.url)}" alt="${escapeHTML(values.alt)}"${values.title?` title="${escapeHTML(values.title)}"`:''}${values.width?` width="${values.width}"`:''}${values.height?` height="${values.height}"`:''}>`;
      else if(image.kind==='html'){
        const edits:Edit[]=[],insertions:string[]=[];
        for(const name of ['alt','title','width','height'] as Property[]){
          if(!changed(name))continue;const found=attrs.filter(attr=>attr.name.toLowerCase()===name),attribute=found[0],value=values[name];
          for(const duplicate of found.slice(1))edits.push({from:duplicate.from,to:duplicate.to,text:''});
          if(attribute){
            if(!value && name!=='alt')edits.push({from:attribute.from,to:attribute.to,text:''});
            else if(attribute.valueFrom!==undefined)edits.push({from:attribute.valueFrom,to:attribute.valueTo!,text:attribute.quote?escapeHTML(value):`"${escapeHTML(value)}"`});
            else edits.push({from:attribute.from,to:attribute.to,text:` ${attribute.name}="${escapeHTML(value)}"`});
          }else if(value || name==='alt')insertions.push(`${name}="${escapeHTML(value)}"`);
        }
        if(insertions.length){const close=/\s*\/?>$/.exec(raw)!;edits.push({from:close.index,to:close.index,text:' '+insertions.join(' ')});}replacement=edited(raw,edits);
      }else if(changed('alt') || changed('title')){
        let node:any;parser.parse(raw).iterate({enter(candidate){if(candidate.name==='Image'){node=candidate.node;return false;}}});
        const close=node.getChildren('LinkMark').find((mark:any)=>raw.slice(mark.from,mark.to)===']'),title=node.getChild('LinkTitle'),url=node.getChild('URL'),end=node.getChildren('LinkMark').find((mark:any)=>raw.slice(mark.from,mark.to)===')'),edits:Edit[]=[];
        if(changed('alt'))edits.push({from:2,to:close.from,text:values.alt.replace(/[\\`*{}[\]()#+\-.!_$~^=<>]/g,'\\$&')});
        if(changed('title')){const text=values.title?`"${values.title.replace(/[\\"]/g,'\\$&')}"`:'';if(title)edits.push({from:text?title.from:url.to,to:title.to,text});else if(text)edits.push({from:end.from,to:end.from,text:' '+text});}replacement=edited(raw,edits);
      }
      const source=options.source.slice(0,image.from)+replacement+options.source.slice(image.to);applied=true;apply.disabled=true;
      options.apply(source,{from:image.from,to:image.from+replacement.length});dialog.close();
    }catch(failure){error.textContent=failure instanceof Error?failure.message:String(failure);}
  });

  void(async()=>{
    try{
      const url=image.url;
      if(/^https?:\/\//i.test(url) || url.startsWith('//')){const remote=new URL(url.startsWith('//')?'https:'+url:url);if(!['http:','https:'].includes(remote.protocol))throw new Error('Unsupported preview URL.');preview.src=remote.href;return;}
      if(/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(url)){preview.src=url;return;}
      if(/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url))throw new Error('Unsupported image preview URL.');
      if(!options.assetRoot || !options.readAsset)throw new Error('Local preview unavailable: an image root and asset reader are required.');
      const rootPath=localImagePath('.',options.assetRoot).replace(/\/$/,'') || '/',path=localImagePath(url,rootPath);
      if(path===rootPath || !(rootPath==='/'?path.startsWith('/'):path.startsWith(rootPath+'/')))throw new Error('Image is outside the existing asset root. Local preview was not read.');
      const asset=await options.readAsset(path,rootPath);if(!live())return;
      if(!asset || !/^image\/[a-z0-9.+-]+$/i.test(asset.type) || typeof asset.base64!=='string' || !/^[a-z0-9+/]*={0,2}$/i.test(asset.base64))throw new Error('Asset reader returned invalid image data.');
      preview.src=`data:${asset.type};base64,${asset.base64}`;
    }catch(failure){if(live())status.textContent=failure instanceof Error?failure.message:String(failure);}
  })();
}
