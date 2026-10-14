import test from 'node:test';import assert from 'node:assert/strict';
import {applyCommand} from '../core/commands.ts';
test('configured inline markers insert literal syntax and existing alternate markers still toggle off',()=>{
  assert.equal(applyCommand('word',{from:0,to:4},{type:'bold'},{boldMarker:'__'}).text,'__word__');
  assert.equal(applyCommand('word',{from:0,to:4},{type:'italic'},{italicMarker:'_'}).text,'_word_');
  assert.equal(applyCommand('__word__',{from:2,to:6},{type:'bold'},{boldMarker:'**'}).text,'word');
});
test('configured bullet markers preserve original CRLF and indentation',()=>assert.equal(applyCommand('one\r\ntwo',{from:0,to:8},{type:'bullet'},{bulletMarker:'+'}).text,'+ one\r\n+ two'));
