import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountApp } from '../client/app.ts';

const dom=new JSDOM('<div id="navigation-audit"></div>',{url:'https://inkleaf.local/',pretendToBeVisual:true});
export const win=dom.window;
for(const key of ['window','Window','Document','document','HTMLElement','Element','Node','Text','MutationObserver','DOMRect','Range','Event','KeyboardEvent','MouseEvent','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','AbortController','AbortSignal','DOMParser'])Object.defineProperty(globalThis,key,{value:key==='window'?win:(win as any)[key],configurable:true,writable:true});
Object.defineProperty(globalThis,'navigator',{value:win.navigator,configurable:true});
for(const key of ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(globalThis,key,{value:(win as any)[key].bind(win),configurable:true,writable:true});
const rect=()=>({x:0,y:0,top:0,left:0,right:800,bottom:600,width:800,height:600,toJSON(){return{};}});
(win.Range.prototype as any).getBoundingClientRect=rect;(win.Range.prototype as any).getClientRects=()=>[];
win.HTMLElement.prototype.getBoundingClientRect=rect;win.HTMLElement.prototype.scrollIntoView=function(){};
(win as any).matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
export const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
export async function until(ready:()=>boolean){for(let i=0;i<150;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Timed out waiting for UI workflow');}
export const q=<T extends HTMLElement=HTMLElement>(selector:string)=>document.querySelector<T>(selector)!;
export function change(selector:string,value:string|boolean,event='change'){
  const control=q<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(selector);assert.ok(control,selector);
  if(typeof value==='boolean')(control as HTMLInputElement).checked=value;else control.value=value;
  control.dispatchEvent(new win.Event(event,{bubbles:true}));return control;
}
export const setting=(key:string,value:string|boolean)=>change(`[data-setting="${key}"]`,value);
export const find=(value:string)=>change('[data-control="find"]',value,'input');
export const option=(key:string,value:boolean)=>change(`[data-control="${key}"]`,value);
export function button(label:string,scope:ParentNode=document){const found=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent===label);assert.ok(found,`Button ${label}`);return found;}
export const snap=(id:string,text:string,path:string|null=`/${id}.md`)=>({documentId:id,path,text,revision:0,savedDigest:path?'saved':null,encoding:'utf8',lineEnding:'LF'});

export async function fixture(t:any,{source='# A\nhello',settings={},handle}:{source?:string;settings?:Record<string,any>;handle?:(message:any)=>any|Promise<any>}={}){
  const root=q('#navigation-audit');root.replaceChildren();
  const messages:any[]=[],themes:any[]=[];let preferences:any={language:'en',watchFiles:false,spellcheck:false,grammarCheck:false,...settings};
  (win as any).webkit={messageHandlers:{native:{postMessage(message:any){messages.push(message);void(async()=>{
    try{
      let result=await handle?.(message);
      if(result===undefined){
        if(message.method==='bootstrap')result={settings:preferences,recoveries:[]};
        else if(message.method==='createDocument')result=snap('a',source);
        else if(message.method==='chooseDocument')result=snap('b','# B\nworld');
        else if(message.method==='openDocument')result=snap(message.args.path,message.args.path,message.args.path);
        else if(message.method==='settings'){if(message.args.values)preferences={...preferences,...message.args.values};result=preferences;}
        else if(message.method==='proofread')result={issues:[],language:message.args.language,languages:['ko','en']};
        else if(message.method==='themeFiles'){
          const {operation,id,name,css}=message.args;
          if(operation==='write'){const theme={id:id??'custom',name,css},index=themes.findIndex(theme=>theme.id===id);if(index>=0)themes[index]=theme;else themes.push(theme);result={theme,themes:[...themes]};}
          else if(operation==='remove'){themes.splice(themes.findIndex(theme=>theme.id===id),1);result={themes:[...themes]};}
          else result={themes:[...themes]};
        }else result={};
      }
      (win as any).__nativeReply({id:message.id,ok:true,result});
    }catch(error){(win as any).__nativeReply({id:message.id,ok:false,error:{code:'io',message:String(error)}});}
  })();}}}};
  const app=await mountApp(root);t.after(()=>app.destroy());
  return {app,root,messages,themes,settings:()=>preferences};
}
