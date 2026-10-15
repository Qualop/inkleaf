import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeSession,recordRecent,moveSessionPath} from '../core/session.ts';
test('session restoration accepts only actual absolute paths and preserves active document',()=>{
  assert.deepEqual(normalizeSession({paths:['/a.md','bad','/a.md','/b.md'],activePath:'/b.md',workspace:'/notes'}),{paths:['/a.md','/b.md'],activePath:'/b.md',workspace:'/notes'});
});
test('missing active path falls back to an open document',()=>{
  assert.deepEqual(normalizeSession({paths:['/a.md'],activePath:'/gone.md',workspace:4}),{paths:['/a.md'],activePath:'/a.md',workspace:null});
});
test('recent locations keep newest first, deduplicate and explicitly cap history',()=>{
  assert.deepEqual(recordRecent(['/b.md','/a.md'],'/a.md',2),['/a.md','/b.md']);
  assert.deepEqual(recordRecent(['/a.md','/b.md'],'/c.md',2),['/c.md','/a.md']);
});
test('rename reconciles document and asset-directory descendants but not siblings',()=>{
  const next=moveSessionPath({paths:['/notes/a.md','/notes-extra/b.md'],activePath:'/notes/a.md',workspace:'/notes'},'/notes','/moved');
  assert.deepEqual(next,{paths:['/moved/a.md','/notes-extra/b.md'],activePath:'/moved/a.md',workspace:'/moved'});
});
test('cursor and scroll positions belong only to restored paths and survive rename',()=>{
  const session=normalizeSession({paths:['/a.md'],views:{'/a.md':{anchor:3,head:8,scroll:120},'/gone.md':{anchor:9,head:9,scroll:4}}});
  assert.deepEqual(session.views,{'/a.md':{anchor:3,head:8,scroll:120}});
  assert.deepEqual(moveSessionPath(session,'/a.md','/renamed.md').views,{'/renamed.md':{anchor:3,head:8,scroll:120}});
});
test('the session document cap also bounds active identity, view state and draft revisions',()=>{
  const documents=Array.from({length:101},(_,index)=>({documentId:`D${index}`,path:null}));
  const session=normalizeSession({documents,activeDocumentId:'D100',views:{D100:{anchor:4,head:4,scroll:8}},draftRevisions:{D100:3}});
  assert.equal(session.documents!.length,100);assert.equal(session.activeDocumentId,'D0');
  assert.equal(session.views?.D100,undefined);assert.equal(session.draftRevisions?.D100,undefined);
});
