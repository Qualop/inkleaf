import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const pandoc=path.resolve('tools/pandoc');
test('bundled exporter produces Word and EPUB artifacts and round-trips Korean content', {skip:!existsSync(pandoc)}, ()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mori-export-'));
  try{
    const source='# 내 문서\n\n한글 **강조**와 수식 $a^2$.\n\n| 이름 | 값 |\n| --- | --- |\n| 표 | 42 |\n';
    for(const format of ['docx','epub']){
      const file=path.join(dir,`한글 결과.${format}`);
      const out=spawnSync(pandoc,['-f','markdown','-t',format,'-o',file],{input:source,encoding:'utf8'});
      assert.equal(out.status,0,out.stderr);
      assert.equal(readFileSync(file).subarray(0,2).toString(),'PK');
      const back=spawnSync(pandoc,['-f',format,'-t','plain',file],{encoding:'utf8'});
      assert.equal(back.status,0,back.stderr);assert.match(back.stdout,/한글 강조/);assert.match(back.stdout,/42/);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
