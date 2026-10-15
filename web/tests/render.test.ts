import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown, markdownBlocks, exportHTML, exportFilename, sanitizeHTML,configureMarkdown } from '../render/markdown.ts';

globalThis.window = new JSDOM('').window as any;
test('mac editing audit: inline math closes after an even backslash run in reading and export',()=>{
  const source=String.raw`$a\\$ and $b\$c$`;
  const document=new JSDOM('').window.document;
  for(const html of [renderMarkdown(source),exportHTML(source)]){
    document.body.innerHTML=html;
    assert.deepEqual([...document.querySelectorAll('[data-math="inline"]')].map(math=>math.textContent),[String.raw`a\\`,String.raw`b\$c`]);
  }
});
test('mac editing audit: valid YAML dot terminators never leak metadata into reading or export',()=>{
  for(const eol of ['\n','\r\n','\r']){
    const source=`\uFEFF--- ${eol}privateField: 숨김${eol}... ${eol}# 본문${eol}${eol}유지😀`;
    for(const html of [renderMarkdown(source),exportHTML(source)]){
      const document=new JSDOM(html).window.document;
      assert.doesNotMatch(document.body.textContent!,/privateField|숨김/);assert.equal(document.querySelector('h1')!.textContent,'본문');assert.match(document.body.textContent!,/유지😀/);
    }
  }
});
test('Markdown preferences have real rendering consumers without changing source',()=>{
  const source='https://example.com\n\n"quoted"...\n\n<u>raw</u>';
  try{configureMarkdown({autoLinks:false,smartPunctuation:true,renderHTML:false});const html=renderMarkdown(source);assert.doesNotMatch(html,/<a href=/);assert.match(html,/“quoted”…/);assert.match(html,/&lt;u&gt;raw/);}finally{configureMarkdown({autoLinks:true,smartPunctuation:false,renderHTML:true});}
});
test('CommonMark mode disables optional Markdown extensions and restores them when switched off',()=>{
  const options={autoLinks:true,smartPunctuation:false,renderHTML:true};
  try{configureMarkdown({...options,strictSyntax:true});assert.doesNotMatch(renderMarkdown('| A | B |\n| - | - |\n| one | two |'),/<table>/);assert.doesNotMatch(renderMarkdown('~~word~~\n\n- [x] task'),/<s>|task-list-item-checkbox/);}finally{configureMarkdown(options);}
  assert.match(renderMarkdown('| A | B |\n| - | - |\n| one | two |'),/<table>/);
});

test('heading anchors are deterministic and duplicate headings get distinct targets', () => {
  const html = renderMarkdown('# 제목\n\n# 제목\n');
  assert.match(html, /id="제목"/);
  assert.match(html, /id="제목-1"/);
});

test('GFM table and checked tasks render real content', () => {
  const html = renderMarkdown('| 이름 | 값 |\n| :--- | ---: |\n| 한글 | 42 |\n\n- [x] 완료\n- [ ] 대기\n');
  assert.match(html, /<table>/);
  assert.match(html, /한글/);
  const dom = new JSDOM('').window.document;
  dom.body.innerHTML = html;
  assert.equal(dom.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
});

test('footnotes and semantic inline styles survive HTML export', () => {
  const html = renderMarkdown('==표시== H~2~O x^2^ 문장[^a]\n\n[^a]: 각주입니다\n');
  assert.match(html, /<mark>표시<\/mark>/);
  assert.match(html, /<sub>2<\/sub>/);
  assert.match(html, /<sup>2<\/sup>/);
  assert.match(html, /각주입니다/);
});

test('all five alert kinds retain the source text and expose their type', () => {
  for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const html = renderMarkdown(`> [!${kind}]\n> 한국어 내용\n`);
    assert.match(html, new RegExp(`data-alert="${kind.toLowerCase()}"`));
    assert.match(html, /한국어 내용/);
  }
});

test('math and diagrams remain typed render jobs, not ordinary code fences', () => {
  const html = renderMarkdown('$a^2$\n\n$$\nb^2\n$$\n\n```mermaid\nflowchart LR\n A-->B\n```\n');
  assert.match(html, /data-math="inline"/);
  assert.match(html, /data-math="block"/);
  assert.match(html, /data-diagram="mermaid"/);
  assert.match(html, /flowchart LR/);
});

test('named code languages generate semantic syntax highlighting while preserving code text', () => {
  const html=renderMarkdown('```javascript\nconst sample = 42;\n```\n');
  assert.match(html,/hljs-keyword/);
  assert.match(html,/hljs-number/);
  assert.match(html,/sample/);
});

test('blocks reference the unnormalized CRLF document offsets', () => {
  const source = '# 헤더\r\n\r\n문장 **강조**\r\n';
  const blocks = markdownBlocks(source);
  assert.equal(source.slice(blocks[0].from, blocks[0].to), '# 헤더\r\n');
  assert.equal(source.slice(blocks[1].from, blocks[1].to), '문장 **강조**\r\n');
});

test('HTML preserves video controls and removes active scripts and event handlers', () => {
  const html = sanitizeHTML('<p onclick="attack()">내용</p><script>attack()</script><video controls src="clip.mp4"></video>');
  assert.match(html, /<p>내용<\/p>/);
  assert.match(html, /<video[^>]*controls/);
  assert.doesNotMatch(html, /attack|onclick|<script/i);
});

test('standalone export embeds metadata, print options and local body without billing', () => {
  const html = exportHTML('# 제목\n\n본문\n', { title: '메모 <1>', author: '작성자', css: 'body{color:#111}', paper:'A4', margin:20 });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>메모 &lt;1&gt;<\/title>/);
  assert.match(html, /name="author" content="작성자"/);
  assert.match(html, /size:A4/);
  assert.match(html, /margin:20mm/);
  assert.match(html, /본문/);
});

test('export filenames use an actual document name or heading and cannot create directory components', () => {
  assert.equal(exportFilename('/tmp/한글.md', '# 다른 제목', 'html'), '한글.html');
  assert.equal(exportFilename(null, '# 제목 / 이름', 'pdf'), '제목 - 이름.pdf');
});
