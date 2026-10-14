import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {diagramSource} from '../render/diagrams.ts';
globalThis.window=new JSDOM('').window as any;
globalThis.document=window.document;
test('legacy sequence arrows and title become a working Mermaid sequence',async()=>{
  const text=diagramSource('sequence','Title: 인사\nAlice->Bob: 안녕\nBob-->Alice: 반가워');
  assert.equal(text,'---\ntitle: "인사"\n---\nsequenceDiagram\nAlice->>Bob: 안녕\nBob-->>Alice: 반가워');
  const mermaid=(await import('mermaid')).default;mermaid.initialize({startOnLoad:false,securityLevel:'strict'});assert.ok(await mermaid.parse(text));
});
test('legacy flow shapes and conditional edges form a working flowchart',async()=>{
  const text=diagramSource('flow','st=>start: 시작\ncond=>condition: 확인\nop=>operation: 처리\ne=>end: 끝\nst->cond\ncond(yes)->op->e\ncond(no)->e');
  assert.match(text,/n_st\(\["시작"\]\)/);assert.match(text,/n_cond\{"확인"\}/);assert.match(text,/n_cond -->\|"yes"\| n_op/);
  const mermaid=(await import('mermaid')).default;assert.ok(await mermaid.parse(text));
});
test('unsupported legacy flow grammar reports its source line',()=>assert.throws(()=>diagramSource('flow','a=>start: begin\nthis is not an edge'),/line 2/i));
test('ordinary Mermaid source retains its exact text',()=>assert.equal(diagramSource('mermaid','flowchart LR\n A-->B'),'flowchart LR\n A-->B'));
