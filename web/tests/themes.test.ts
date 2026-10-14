import test from 'node:test';
import assert from 'node:assert/strict';
import { builtInThemes, scopeThemeCSS, resolveDocumentTheme, normalizeUserThemes, themeExportCSS } from '../client/themes.ts';

test('document themes are distinct from system appearance and unknown selections fall back',()=>{
  assert.deepEqual(builtInThemes.map(t=>t.id),['default','github','newsprint','night','pixyll','whitey']);
  assert.equal(resolveDocumentTheme('night',[]).appearance,'dark');
  assert.equal(resolveDocumentTheme('missing',[]).id,'default');
  assert.notEqual(resolveDocumentTheme('github',[]).css,resolveDocumentTheme('newsprint',[]).css);
});
test('Imported document selectors and nested media rules target only Mori document surfaces',()=>{
  const css=scopeThemeCSS(':root{--bg-color:#fafafa} body{font-family:Georgia} #write h1, #write h2{color:red} @media(max-width:600px){#write{padding:12px}}');
  assert.match(css,/\.mori-app\[data-document-theme\]\{--bg-color/);assert.match(css,/\.cm-content/);assert.match(css,/\.reading/);
  assert.doesNotMatch(css,/#write|(?:^|\})\s*body\{/);
  assert.match(css,/@media\(max-width:600px\)/);assert.match(css,/padding:12px/);
});
test('theme selector parsing retains commas in functional selectors, strings and comments',()=>{
  const css=scopeThemeCSS('#write :is(h1,h2){font-family:"A,B";content:"}"} /* ok */ @supports(display:grid){p{color:red}}');
  assert.match(css,/:is\(h1,h2\)/);assert.match(css,/"A,B"/);assert.match(css,/@supports/);
});
test('external imports and URLs are rejected while embedded local assets and font-face work',()=>{
  assert.throws(()=>scopeThemeCSS('@import "https://example.com/theme.css";'),/import/i);
  assert.throws(()=>scopeThemeCSS('body{background:url(file:///secret)}'),/resource|URL/i);
  assert.throws(()=>scopeThemeCSS('p{background:url(https://example.com/x)}'),/resource|URL/i);
  assert.match(scopeThemeCSS('@font-face{font-family:Local;src:url("data:font/woff2;base64,AA==")} #write{font-family:Local}'),/@font-face/);
});
test('invalid syntax, oversized themes and invalid personal theme identities are rejected',()=>{
  assert.throws(()=>scopeThemeCSS('p{color:red'),/syntax|unclosed/i);
  assert.throws(()=>scopeThemeCSS('x'.repeat(1_048_577)),/large|size/i);
  assert.deepEqual(normalizeUserThemes([{id:'../bad',name:'Bad',css:'p{}'},{id:'local',name:'개인 테마',css:'p{color:red}'}]).map(t=>t.id),['user:local']);
  const theme=resolveDocumentTheme('user:local',normalizeUserThemes([{id:'local',name:'개인 테마',css:'p{color:red}'}]));assert.equal(theme.name,'개인 테마');assert.match(theme.css,/color:red/);
});
test('body theme colors and typography affect both rendered and active Markdown, including exports',()=>{
  const css=scopeThemeCSS('body{color:#abc;background:#123;font-family:Georgia} #write h1{color:red}');assert.match(css,/--text:#abc/);assert.match(css,/--canvas:#123/);assert.match(css,/--theme-font:Georgia/);
  const exported=themeExportCSS({id:'user:custom',name:'Test',css});assert.doesNotMatch(exported,/\.mori-app|\.cm-content/);assert.match(exported,/article h1/);assert.match(exported,/background:var\(--canvas\)/);
});
