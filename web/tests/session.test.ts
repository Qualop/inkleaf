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
