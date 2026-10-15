import test from 'node:test';
import assert from 'node:assert/strict';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { proofreadingState } from '../client/proofreading.ts';
import { fixture,win,q,change,setting,find,option,button,tick,until } from './navigation-harness.ts';

test('document search runs whole-word Unicode, regex groups, replace-one/all and undo through UI callbacks',async t=>{
  const source='😀 cat cats CAT\r\n한국 한국어 한국\r\ncat-12 cat-34', {app}=await fixture(t,{source});
  await app.action('find');find('한국');option('wholeWord',true);
  assert.match(q('[data-search-status]').textContent!,/^2 matches/);
  await app.action('next-match');assert.equal(source.slice(app.editor.selection().from,app.editor.selection().to),'한국');
  option('wholeWord',false);option('regex',true);find('cat-(?<n>\\d+)');
  change('[data-control="replacement"]','$<n>!');await app.action('replace-one');
  assert.equal(app.editor.text(),source.replace('cat-12','12!'));undo(app.editor.view);await until(()=>q('[data-search-status]').textContent!.startsWith('2 matches'));
  await app.action('replace-all');assert.equal(app.editor.text(),source.replace('cat-12','12!').replace('cat-34','34!'));undo(app.editor.view);assert.equal(app.editor.text(),source);
  find('[');assert.match(q('[data-search-status]').textContent!,/Invalid regular expression/);
  assert.equal(q<HTMLButtonElement>('[data-action="replace-all"]').disabled,true);
  option('regex',false);find('CAT');option('caseSensitive',true);assert.match(q('[data-search-status]').textContent!,/^1 match/);
});

test('zero-width regex replacement preserves astral characters and native regex substitutions',async t=>{
  const source='😀a\r\nb',{app}=await fixture(t,{source});await app.action('find');option('regex',true);find('(?=.)');
  change('[data-control="replacement"]','|');await app.action('replace-all');assert.equal(app.editor.text(),'|😀|a\r\n|b');
  undo(app.editor.view);find('(a)');change('[data-control="replacement"]','$$:$&:$1');await app.action('replace-all');assert.equal(app.editor.text(),'😀$:a:a\r\nb');
});

test('file tree honors directory-first natural/name/modified/size order; pins, recents and quick-open select actual paths',async t=>{
  const entries=[{name:'note10.md',path:'/work/note10.md',size:1,modified:3},{name:'note2.md',path:'/work/note2.md',size:9,modified:1},{name:'nested',path:'/work/nested',isDirectory:true}];
  const {app,messages}=await fixture(t,{handle:m=>m.method==='chooseWorkspace'?'/work':m.method==='listDirectory'?(m.args.path==='/work'?entries:[{name:'한국.md',path:'/work/nested/한국.md'}]):undefined});
  await app.action('folder');const names=()=>[...document.querySelectorAll('.file-tree > .file-entry > button')].map(node=>node.textContent);
  assert.deepEqual(names(),['nested','note2.md','note10.md']);
  change('[data-control="file-sort"]','modified');await until(()=>names()[1]==='note10.md');
  change('[data-control="file-sort"]','size');await until(()=>names()[1]==='note2.md');
  await app.action('pin-folder');assert.deepEqual(app.preferences.pinnedFolders,['/work']);
  await app.action('quick-open');change('dialog input','한국','input');assert.equal(q('.quick-results button').getAttribute('title'),'/work/nested/한국.md');q<HTMLButtonElement>('.quick-results button').click();
  await until(()=>app.documents.size===2);assert.equal(app.documents.get(app.activeId)!.path,'/work/nested/한국.md');
  await app.action('quick-open');assert.equal(q('.quick-results button').title,'/work/nested/한국.md');button('Pinned: work').click();await tick();
  assert.ok(messages.some(m=>m.method==='settings'&&m.args.values?.recentFolders.includes('/work')));
});

test('mounted outline controls preserve hierarchy, current heading, depth, filter context and source offsets',async t=>{
  const source='# Root\n## 중간\n### Cafe\u0301\nbody\n## End', {app}=await fixture(t,{source});await app.action('outline');
  change('[data-outline-depth]','1');assert.equal(document.querySelectorAll('[data-outline-row]').length,1);
  change('[data-outline-filter]','Café','input');assert.equal(document.querySelectorAll('[data-outline-row]').length,3);
  q<HTMLButtonElement>('[data-outline-level="3"] [data-outline-select]').click();assert.equal(source.slice(app.editor.selection().from,app.editor.selection().to),'### Cafe\u0301');
  assert.equal(q('[aria-current="location"]').textContent!.includes('Cafe\u0301'),true);
  q<HTMLButtonElement>('[data-outline-clear-filter]').click();change('[data-outline-depth]','6');q<HTMLButtonElement>('[data-outline-collapse-all]').click();
  assert.equal(document.querySelectorAll('[data-outline-row]').length,1);assert.match(q('[data-outline-current]').textContent!,/not shown/);
  q<HTMLButtonElement>('[data-outline-expand-all]').click();assert.equal(document.querySelectorAll('[data-outline-row]').length,4);assert.equal(app.editor.text(),source);
});

test('theme editor creates, edits and deletes managed copies without modifying source or undo history',async t=>{
  const {app,messages}=await fixture(t);app.editor.replace('# A\nhello!');await app.action('themes');button('New CSS Theme…').click();
  change('[data-theme-name]','Personal 테마');change('[data-theme-source]','#write { color: #123456; }');button('Save Theme').click();
  await until(()=>!!document.querySelector('[data-theme-option="user:custom"]'));assert.equal(app.root.dataset.documentTheme,'user:custom');
  button('Edit CSS').click();change('[data-theme-source]','#write { color: #654321; }');button('Save Theme').click();
  await until(()=>!!document.querySelector('[data-theme-option="user:custom"]'));assert.match(q('[data-theme-css]').textContent!,/#654321/);
  button('Delete Theme').click();button('Delete Theme',q('dialog footer')).click();await until(()=>!!document.querySelector('.theme-dialog')&&!document.querySelector('[data-theme-option="user:custom"]'));
  assert.equal(app.root.dataset.documentTheme,'default');assert.ok(messages.some(m=>m.method==='themeFiles'&&m.args.operation==='remove'&&m.args.id==='custom'));
  assert.equal(app.editor.text(),'# A\nhello!');undo(app.editor.view);assert.equal(app.editor.text(),'# A\nhello');
});

test('conditional theme variables stay within media/supports conditions when applied to the editor',async t=>{
  const css='body{color:#111;background:#fff}@media print{body{color:#eee;background:#000}}';
  const {app}=await fixture(t,{handle:m=>m.method==='themeFiles'?{themes:[{id:'print',name:'Print',css}]}:undefined});
  await app.action('themes');q<HTMLButtonElement>('[data-theme-option="user:print"]').click();await until(()=>app.root.dataset.documentTheme==='user:print');
  const sheet=q<HTMLStyleElement>('[data-theme-css]').sheet!;
  const rootRules=[...sheet.cssRules].filter(rule=>rule.type===win.CSSRule.STYLE_RULE).map(rule=>rule.cssText).join('\n');
  assert.doesNotMatch(rootRules,/--text:\s*#eee|--canvas:\s*#000/);
  assert.match([...sheet.cssRules].find(rule=>rule.type===win.CSSRule.MEDIA_RULE)!.cssText,/--text:\s*#eee/);
});

test('Korean navigation chrome translates while heading text, filenames and input values stay literal',async t=>{
  const {app}=await fixture(t,{settings:{language:'ko'},source:'# Search\n## Filter headings'});
  await app.action('outline');await tick();
  assert.equal(q('[data-outline-filter]').getAttribute('aria-label'),'제목 필터');
  assert.equal(q('[data-outline-depth]').getAttribute('aria-label'),'최대 제목 수준');
  assert.equal(q('[data-outline-expand-all]').textContent,'모두 펼치기');
  assert.equal(q('[data-outline-title]').textContent,'Search');
  await app.action('quick-open');await tick();assert.equal(q<HTMLInputElement>('dialog input').placeholder,'파일 이름 검색');
  assert.equal(q('.quick-results button').textContent,'a.md');assert.equal(app.editor.text(),'# Search\n## Filter headings');
});

test('settings categories support arrow-key switching and expose every control in the expected category',async t=>{
  const {app}=await fixture(t);await app.action('settings');
  for(const [category,keys] of Object.entries({general:['language','restoreSession','restoreUnsaved','autoSave','watchFiles'],appearance:['appIcon','documentTheme','theme','fontFamily','fontSize','documentWidth','lineHeight','focus','typewriter','customCSS'],editor:['mode','wrap','lineNumbers','tabSize','pairing','boldMarker','italicMarker','bulletMarker','defaultCodeLanguage','rememberCodeLanguage','emojiCompletion','richPaste','autoLinks','strictSyntax','smartPunctuation','renderHTML'],proofreading:['spellcheck','grammarCheck','spellLanguage','personalDictionary'],images:['imageUploaderPath','imageUploaderArguments'],math:['mathNumbering','mathPhysics'],export:['pandocPath']})){
    q<HTMLButtonElement>(`button[data-settings-category="${category}"]`).click();for(const key of keys){assert.ok(q(`[data-setting="${key}"]`),`Missing settings control: ${key}`);assert.equal(q(`[data-setting="${key}"]`).closest<HTMLElement>('[data-settings-panel]')!.hidden,false,key);}
  }
  const exportTab=q<HTMLButtonElement>('button[data-settings-category="export"]');exportTab.focus();exportTab.dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.equal(document.activeElement,q('button[data-settings-category="general"]'));assert.equal(q('button[data-settings-category="general"]').getAttribute('aria-selected'),'true');
  q('button[data-settings-category="appearance"]').click();setting('fontSize','25');setting('tabSize','8');assert.equal(app.root.style.getPropertyValue('--font-size'),'25px');assert.equal(app.editor.view.state.tabSize,8);
});

test('focus/typewriter consumers follow scoped tabs, preserve source/history and request centered scrolling',async t=>{
  const {app}=await fixture(t,{source:'# A\n\nParagraph one.\n\nParagraph two.'});app.editor.replace('# A\n\nParagraph one!\n\nParagraph two.');
  await app.action('settings');change('[data-document-preference-scope]',true);setting('focus',true);setting('typewriter',true);
  assert.equal(app.root.dataset.focus,'true');assert.equal(app.root.dataset.typewriter,'true');
  assert.equal(q('[data-action="focus"]').getAttribute('aria-pressed'),'true');
  q<HTMLButtonElement>('dialog header button').click();
  const scroll=EditorView.scrollIntoView,calls:any[]=[];
  EditorView.scrollIntoView=(position,options)=>{calls.push(options);return scroll(position,options);};t.after(()=>{EditorView.scrollIntoView=scroll;});
  app.editor.select({from:7,to:7});await until(()=>calls.some(options=>options?.y==='center'));
  await app.action('open');assert.equal(app.root.dataset.focus,'false');assert.equal(app.root.dataset.typewriter,'false');
  q<HTMLButtonElement>('[data-document="a"] [role="tab"]').click();assert.equal(app.root.dataset.typewriter,'true');assert.equal(app.root.dataset.focus,'true');
  undo(app.editor.view);assert.equal(app.editor.text(),'# A\n\nParagraph one.\n\nParagraph two.');
});

test('all global settings controls validate and reach persisted preferences without source mutations',async t=>{
  const {app,settings}=await fixture(t);await app.action('settings');
  const values:Record<string,string|boolean>={restoreSession:false,restoreUnsaved:false,autoSave:true,watchFiles:false,theme:'dark',fontFamily:'mono',fontSize:'24',documentWidth:'960',lineHeight:'2',wrap:false,lineNumbers:true,focus:true,typewriter:true,pandocPath:'/tmp/audit-pandoc',mathNumbering:'ams',mathPhysics:true,imageUploaderPath:'/tmp/audit-uploader',imageUploaderArguments:'["--literal"]',tabSize:'8',boldMarker:'__',italicMarker:'_',bulletMarker:'+',pairing:false,defaultCodeLanguage:'python',rememberCodeLanguage:false,spellcheck:false,grammarCheck:false,spellLanguage:'ko',emojiCompletion:false,richPaste:false,autoLinks:false,strictSyntax:true,smartPunctuation:true,renderHTML:false,customCSS:'.audit-test { color: red; }'};
  for(const [key,value] of Object.entries(values))setting(key,value);
  await until(()=>settings().customCSS===values.customCSS);
  for(const [key,value] of Object.entries(values))assert.equal((app.preferences as any)[key],['fontSize','documentWidth','lineHeight','tabSize'].includes(key)?Number(value):value,key);
  assert.equal(app.root.dataset.theme,'dark');assert.equal(app.root.style.getPropertyValue('--document-width'),'960px');assert.equal(app.root.style.getPropertyValue('--line-height'),'2');assert.equal(app.editor.view.state.tabSize,8);
  app.setMode('source');assert.ok(app.root.querySelector('.cm-lineNumbers'));assert.equal(app.editor.view.contentDOM.classList.contains('cm-lineWrapping'),false);assert.match(q('[data-user-css]').textContent!,/audit-test/);
  assert.equal(app.editor.text(),'# A\nhello');
  setting('imageUploaderArguments','not JSON');assert.equal(q('[data-setting="imageUploaderArguments"]').getAttribute('aria-invalid'),'true');assert.equal(app.preferences.imageUploaderArguments,'["--literal"]');
  setting('fontSize','999');assert.equal(app.root.style.getPropertyValue('--font-size'),'36px');
  q<HTMLButtonElement>('[data-action="reset-settings"]').click();await until(()=>settings().fontSize===18);
  assert.equal(app.root.dataset.focus,'false');assert.equal(app.editor.view.state.tabSize,4);assert.equal(q('[data-user-css]').textContent,'');assert.equal(app.preferences.appIcon,'ink');
});

test('theme import cancellation and malformed CSS preserve selected theme and source',async t=>{
  let imported=false;
  const theme={id:'imported',name:'Imported',css:'#write {color:navy}'};
  const {app,messages}=await fixture(t,{handle:m=>m.method==='themeFiles'?(m.args.operation==='import'?(imported?null:(imported=true,{theme})):m.args.operation==='list'?{themes:imported?[theme]:[]}:undefined):undefined});
  await app.action('import-theme');assert.equal(app.root.dataset.documentTheme,'user:imported');await app.action('import-theme');assert.equal(app.root.dataset.documentTheme,'user:imported');
  button('New CSS Theme…').click();change('[data-theme-name]','Broken');change('[data-theme-source]','p {color:red');button('Save Theme').click();await until(()=>!button('Save Theme').disabled);
  assert.match(q('[data-message]').textContent!,/Unclosed/);assert.equal(messages.filter(m=>m.method==='themeFiles'&&m.args.operation==='write').length,0);
  assert.equal(app.editor.text(),'# A\nhello');assert.equal(app.root.dataset.documentTheme,'user:imported');
});

test('spelling language, grammar toggles and native personal-dictionary learning flow through real suggestion controls',async t=>{
  let learned=false;
  const source='wrng 한국어';
  const {app,messages}=await fixture(t,{source,settings:{spellcheck:true,grammarCheck:false,spellLanguage:'en'},handle:m=>{
    if(m.method!=='proofread')return;
    if(m.args.operation==='learn'){learned=true;return {word:'wrng',personalDictionary:['wrng']};}
    return {language:m.args.language,languages:['en','ko'],issues:learned?[]:[{from:0,to:4,kind:'spelling',message:'Check spelling.',suggestions:['wrong']}]};
  }});
  await until(()=>app.editor.view.state.field(proofreadingState).issues.length===1);
  app.editor.select({from:1,to:1});app.editor.view.contentDOM.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}));
  await until(()=>!!document.querySelector('.mori-proofreading-menu'));button('Add to personal dictionary').click();
  await until(()=>app.preferences.personalDictionary.includes('wrng'));await until(()=>app.editor.view.state.field(proofreadingState).issues.length===0);
  assert.ok(messages.some(m=>m.method==='proofread'&&m.args.operation==='learn'&&m.args.word==='wrng'));
  await app.action('proofreading-settings');assert.equal(q('dialog').dataset.settingsCategory,'proofreading');setting('spellLanguage','ko');setting('grammarCheck',true);
  await until(()=>messages.some(m=>m.method==='proofread'&&m.args.operation==='check'&&m.args.language==='ko'));
  setting('spellcheck',false);setting('grammarCheck',false);await tick();assert.equal(app.editor.view.state.field(proofreadingState).issues.length,0);
  assert.equal(app.editor.view.contentDOM.getAttribute('spellcheck'),'false');assert.equal(app.editor.text(),source);
});
