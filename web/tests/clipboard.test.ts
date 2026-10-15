import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown } from '../core/clipboard.ts';
import { renderMarkdown } from '../render/markdown.ts';
globalThis.window = new JSDOM('').window as any;
test('rich text retains headings, formatting and Korean',()=>assert.equal(htmlToMarkdown('<h2>제목</h2><p><strong>굵게</strong> <em>기울임</em><br>다음</p>'),'## 제목\n\n**굵게** *기울임*  \n다음'));
test('literal markdown metacharacters remain literal',()=>assert.equal(htmlToMarkdown('<p>*literal* [word] \\</p>'),'\\*literal\\* \\[word\\] \\\\'));
test('code fence grows beyond embedded backticks',()=>assert.equal(htmlToMarkdown('<pre><code class="language-js">const x = ```;\n</code></pre>'),'````js\nconst x = ```;\n````'));
test('lists and quotes remain structural',()=>assert.equal(htmlToMarkdown('<blockquote><p>quote</p></blockquote><ol start="3"><li>one</li><li>two<ul><li>child</li></ul></li></ol>'),'> quote\n\n3. one\n4. two\n   - child'));
test('safe links and images retain title and escaped paths',()=>assert.equal(htmlToMarkdown('<p><a href="https://example.com/a b" title="제목">link</a> <img src="assets/a.png" alt="그림"></p>'),'[link](<https://example.com/a b> "제목") ![그림](<assets/a.png>)'));
test('rectangular tables become editable Markdown',()=>assert.equal(htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>one|two</td><td>42</td></tr></table>'),'| A | B |\n| --- | --- |\n| one\\|two | 42 |'));
test('complex tables preserve sanitized HTML rather than losing merged cells',()=>assert.match(htmlToMarkdown('<table><tr><td colspan="2">keep</td></tr></table>'),/colspan="2">keep/));
test('active content and unsafe URLs never become Markdown links',()=>assert.equal(htmlToMarkdown('<script>bad()</script><p onclick="bad()"><a href="javascript:bad()">safe text</a></p>'),'safe text'));

const codeHTML=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const codePayloads=[
  ['internal blank lines','one\n\n\ntwo\n','one\n\n\ntwo\n'],
  ['leading and trailing blank lines','\n\none\n\n\n','\n\none\n\n\n'],
  ['HTML CRLF normalization','\r\none\r\n\r\n\r\ntwo\r\n','\none\n\n\ntwo\n'],
  ['missing terminal newline','one','one'],
  ['empty payload','',''],
  ['whitespace-only payload',' \t \n\n',' \t \n\n'],
  ['embedded fence and literal markup','```\n````\n**한😀**\n','```\n````\n**한😀**\n'],
  ['literal placeholder-shaped text','\uE0000\uE000\n\n\n\uE000html0\uE000\n','\uE0000\uE000\n\n\n\uE000html0\uE000\n'],
] as const;
const codeContexts=[
  ['standalone',(code:string)=>code],
  ['quote',(code:string)=>`<blockquote>${code}</blockquote>`],
  ['ordered list',(code:string)=>`<ol start="3"><li><p>item</p>${code}</li></ol>`],
  ['nested list quote',(code:string)=>`<ul><li><p>outer</p><blockquote>${code}</blockquote></li></ul>`],
] as const;
for(const [context,wrap] of codeContexts)for(const [name,input,expected] of codePayloads)test(`rich pasted code preserves ${name} in ${context}`,()=>{
  const html=wrap(`<pre><code class="language-js">${codeHTML(input)}</code></pre>`),markdown=htmlToMarkdown(html);
  const document=new JSDOM(renderMarkdown(markdown)).window.document,codes=document.querySelectorAll('pre code');
  assert.equal(codes.length,1,markdown);assert.equal(codes[0].textContent,expected,markdown);
  if(context==='quote')assert.ok(document.querySelector('blockquote pre code'));
  if(context==='ordered list')assert.equal(document.querySelector('ol')!.getAttribute('start'),'3');
  if(context==='nested list quote')assert.ok(document.querySelector('li blockquote pre code'));
});

for(const payload of ['',' ','  ','\t',' leading ','`tick`','one\ntwo','one\n\ntwo','\n\n*한😀*\t\n','\uE0000\uE000\n**literal**','<script>literal</script>\n& text'])test(`inline code whitespace round-trips ${JSON.stringify(payload)}`,()=>{
  const markdown=htmlToMarkdown(`<p>before <code>${codeHTML(payload)}</code> after</p>`),document=new JSDOM(renderMarkdown(markdown)).window.document;
  assert.equal(document.querySelector('code')!.textContent,payload,markdown);assert.equal(document.querySelector('script'),null);assert.equal(document.body.textContent,`before ${payload} after\n`);
});

test('adjacent pasted code blocks retain separate exact payloads and surrounding prose',()=>{
  const html='<p>before</p><ul><li><p>item</p><pre><code>a\n\n\nb\n</code></pre><pre><code>\nlast</code></pre></li></ul><p>after</p>';
  const markdown=htmlToMarkdown(html),document=new JSDOM(renderMarkdown(markdown)).window.document;
  assert.deepEqual([...document.querySelectorAll('pre code')].map(code=>code.textContent),['a\n\n\nb\n','\nlast']);
  assert.match(document.body.textContent!,/^before/);assert.match(document.body.textContent!,/after\n$/);
});
test('pre without a code child preserves HTML parser leading-newline normalization',()=>{
  const markdown=htmlToMarkdown('<pre>\n\none\n\n\n</pre>'),document=new JSDOM(renderMarkdown(markdown)).window.document;
  assert.equal(document.querySelector('pre')!.textContent,'\none\n\n\n');
});
test('table cells with preformatted code retain literal payloads instead of becoming pipe-table line breaks',()=>{
  const markdown=htmlToMarkdown('<table><tr><td><pre><code>a\n\n\nb</code></pre></td></tr></table>'),document=new JSDOM(renderMarkdown(markdown)).window.document;
  assert.equal(document.querySelector('td pre code')!.textContent,'a\n\n\nb');
});
