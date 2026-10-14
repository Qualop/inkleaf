import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxTree } from '@codemirror/language';
import { CompletionContext, insertCompletionText } from '@codemirror/autocomplete';
import { emojiCompletionSource } from '../client/completion.ts';

function state(source:string){return EditorState.create({doc:source,extensions:[markdown({codeLanguages:info=>info==='js'?javascript().language:null})]});}
async function complete(source:string,position=source.length,explicit=false){const editor=state(source);const result=await emojiCompletionSource(new CompletionContext(editor,position,explicit));assert.equal(editor.doc.toString(),source);return {editor,result};}

test('colon prefix produces named emoji suggestions with literal replacement positions',async()=>{
  const {result}=await complete('hello :smi');assert.ok(result);assert.equal(result.from,6);assert.equal(result.to,10);
  assert.deepEqual(result.options.map(option=>[option.label,option.apply]),[[':smile:','😄'],[':smiley:','😃']]);
});
test('completion insertion preserves preceding Korean and surrogate-pair Unicode offsets',async()=>{
  const {editor,result}=await complete('한글😀 :smi');assert.ok(result);assert.equal(result.from,5);assert.equal(result.to,9);
  const option=result.options.find(option=>option.label===':smile:')!;assert.equal(option.apply,'😄');
  const changed=editor.update(insertCompletionText(editor,option.apply as string,result.from,result.to!)).state;
  assert.equal(changed.doc.toString(),'한글😀 😄');assert.equal(editor.doc.toString(),'한글😀 :smi');
});
test('plus-one and minus-one prefixes insert actual emoji rather than shortcode text',async()=>{
  for(const [source,label,emoji] of [[':+1',':+1:','👍'],[':-1',':-1:','👎']]){
    const {editor,result}=await complete(source);assert.ok(result);assert.equal(result.from,0);assert.equal(result.to,3);assert.deepEqual(result.options.map(option=>[option.label,option.apply]),[[label,emoji]]);
    assert.equal(editor.update(insertCompletionText(editor,result.options[0].apply as string,0,3)).state.doc.toString(),emoji);
  }
});
test('bare colon exposes a bounded common catalogue with literal named mappings',async()=>{
  const {result}=await complete(':');assert.ok(result);assert.equal(result.from,0);assert.equal(result.to,1);assert.ok(result.options.length>=30 && result.options.length<=50);
  for(const [label,emoji] of [[':heart:','❤️'],[':rocket:','🚀'],[':warning:','⚠️'],[':white_check_mark:','✅'],[':coffee:','☕'],[':100:','💯']])assert.equal(result.options.find(option=>option.label===label)?.apply,emoji,label);
  assert.equal(new Set(result.options.map(option=>option.label)).size,result.options.length);
});
test('case-insensitive and underscore prefixes use the complete colon-delimited replacement span',async()=>{
  const upper=await complete(':SMI');assert.ok(upper.result);assert.equal(upper.result.options[0].label,':smile:');
  const underscore=await complete(':heart_');assert.ok(underscore.result);assert.equal(underscore.result.from,0);assert.equal(underscore.result.to,7);assert.equal(underscore.result.options[0].apply,'😍');
});
test('no colon, unknown prefixes, completed shortcodes and URL destinations yield no suggestions',async()=>{
  for(const source of ['plain smile','',':unknown_name',':smile:','::smi','https://example.invalid/:smi','[link](https://example.invalid/:smi)']){
    const position=source.endsWith(')')?source.length-1:source.length;assert.equal((await complete(source,position,true)).result,null,source);
  }
});
test('inline, fenced and indented code suppress completion',async()=>{
  for(const [source,position] of [['`a :smi`',7],['```\n:smi\n```',8],['~~~md\n:smi\n~~~',10],['    :smi',8],['```js\n:smi',10]] as [string,number][]){assert.equal((await complete(source,position,true)).result,null,source);}
});
test('outer Markdown syntax suppresses fenced JavaScript even when the inner node is a String',async()=>{
  const source='```js\nconst x=":smi";\n```',editor=state(source),context=new CompletionContext(editor,19,true);
  assert.equal(syntaxTree(editor).resolveInner(19,-1).name,'String');assert.equal(await emojiCompletionSource(context),null);assert.equal(editor.doc.toString(),source);
});
test('prose following a closed code fence completes at a literal document offset',async()=>{
  const {result}=await complete('```\ncode\n```\n:smi');assert.ok(result);assert.equal(result.from,13);assert.equal(result.to,17);assert.equal(result.options[0].apply,'😄');
});
