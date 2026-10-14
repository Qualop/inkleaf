export interface DocumentViewState{anchor:number;head:number;scroll:number}
export interface SavedSession{paths:string[];activePath:string|null;workspace:string|null;views?:Record<string,DocumentViewState>;documents?:{documentId:string;path:string|null}[];activeDocumentId?:string|null;draftRevisions?:Record<string,number>}
const pathValue=(value:unknown):string|null=>typeof value==='string'&&value.startsWith('/')&&!value.includes('\0')?(value==='/'?value:value.replace(/\/+$/,'')):null;
export function normalizeSession(value:unknown):SavedSession{
  const data=value&&typeof value==='object'&&!Array.isArray(value)?value as Partial<SavedSession>:{};
  const paths=[...new Set((Array.isArray(data.paths)?data.paths:[]).map(pathValue).filter((p):p is string=>p!==null))].slice(0,100);
  const active=pathValue(data.activePath),result:SavedSession={paths,activePath:active&&paths.includes(active)?active:paths[0]??null,workspace:pathValue(data.workspace)},views:Record<string,DocumentViewState>={};
  const identities=new Set<string>();
  if(Array.isArray(data.documents)){result.documents=data.documents.flatMap(item=>{if(!item||typeof item.documentId!=='string'||!item.documentId||item.documentId.length>128||item.documentId.includes('\0')||identities.has(item.documentId)||(item.path!==null&&!pathValue(item.path)))return [];identities.add(item.documentId);return [{documentId:item.documentId,path:pathValue(item.path)}];}).slice(0,100);result.activeDocumentId=typeof data.activeDocumentId==='string'&&identities.has(data.activeDocumentId)?data.activeDocumentId:result.documents[0]?.documentId??null;const drafts=Object.entries(data.draftRevisions??{}).filter(([id,revision])=>identities.has(id)&&Number.isSafeInteger(revision)&&revision>=0);if(drafts.length)result.draftRevisions=Object.fromEntries(drafts);}
  for(const path of [...paths,...identities]){const view=data.views?.[path];if(view && Number.isInteger(view.anchor)&&view.anchor>=0&&Number.isInteger(view.head)&&view.head>=0&&Number.isFinite(view.scroll)&&view.scroll>=0)views[path]={anchor:Math.min(view.anchor,1e9),head:Math.min(view.head,1e9),scroll:Math.min(view.scroll,1e8)};}
  if(Object.keys(views).length)result.views=views;return result;
}
export function recordRecent(history:unknown,path:string,limit=30):string[]{
  const next=pathValue(path);const prior=Array.isArray(history)?history.map(pathValue).filter((p):p is string=>p!==null):[];
  return[...new Set([...(next?[next]:[]),...prior])].slice(0,Math.max(0,Math.min(100,Math.floor(limit))));
}
export function moveSessionPath(session:SavedSession,from:string,to:string):SavedSession{
  const old=pathValue(from),destination=pathValue(to);if(!old||!destination)return normalizeSession(session);
  const replace=(path:string|null)=>path&&(path===old||path.startsWith(old+'/'))?destination+path.slice(old.length):path;
  return normalizeSession({...session,paths:session.paths.map(p=>replace(p)),activePath:replace(session.activePath),workspace:replace(session.workspace),documents:session.documents?.map(doc=>({...doc,path:replace(doc.path)})),views:session.views?Object.fromEntries(Object.entries(session.views).map(([path,value])=>[replace(path),value])):undefined});
}
