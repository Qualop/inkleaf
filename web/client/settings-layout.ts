import type { Modal } from './dialog.ts';
const categories = [
  {id:'general',en:'General',ko:'일반',keys:['language','restoreSession','restoreUnsaved','autoSave','watchFiles']},
  {id:'appearance',en:'Appearance',ko:'모양과 테마',keys:['appIcon','documentTheme','theme','fontFamily','fontSize','documentWidth','lineHeight','focus','typewriter','customCSS']},
  {id:'editor',en:'Editor',ko:'편집',keys:['mode','wrap','lineNumbers','tabSize','pairing','boldMarker','italicMarker','bulletMarker','defaultCodeLanguage','rememberCodeLanguage','emojiCompletion','richPaste','autoLinks','strictSyntax','smartPunctuation','renderHTML','finalNewline']},
  {id:'proofreading',en:'Spelling & Dictionary',ko:'맞춤법과 사전',keys:['spellcheck','grammarCheck','spellLanguage','personalDictionary']},
  {id:'images',en:'Images',ko:'이미지',keys:['imageUploaderPath','imageUploaderArguments']},
  {id:'math',en:'Math',ko:'수식',keys:['mathNumbering','mathPhysics']},
  {id:'export',en:'Export',ko:'내보내기',keys:['pandocPath']}
];
const hints:Record<string,[string,string]>={
  language:['Changes menus, settings and messages. Your documents keep their original text.','메뉴·설정·안내 문구의 언어를 바꿉니다. 문서 내용은 바뀌지 않습니다.'],
  restoreSession:['Reopens your documents and cursor positions when Inkleaf starts.','앱을 다시 열면 이전에 열어 둔 문서와 커서 위치를 복원합니다.'],
  restoreUnsaved:['Keeps unsaved work as local drafts when you quit. This does not overwrite the original files.','종료할 때 저장하지 않은 내용을 앱의 임시 문서로 보관합니다. 원본 파일을 덮어쓰지는 않습니다.'],
  autoSave:['Writes changes to files that already have a save location. New documents are kept as local drafts until you choose a location.','저장 위치가 있는 파일의 변경 내용을 자동으로 저장합니다. 새 문서는 위치를 정하기 전까지 임시 문서로 보관합니다.'],
  watchFiles:['Reads changes made by other apps. If both copies changed, Inkleaf keeps your edits and asks how to save.','다른 앱이 바꾼 파일을 확인합니다. 양쪽에서 수정했으면 현재 내용을 보존하고 저장 방법을 묻습니다.'],
  appIcon:['Changes the Dock and app-switcher icon for all documents. Finder and the installer retain the default Black Ink icon.','모든 문서에 공통으로 Dock과 앱 전환기 아이콘을 바꿉니다. Finder와 설치 프로그램에는 기본 검은 잉크 아이콘이 유지됩니다.'],
  documentTheme:['Changes the document colors and typography. Manage or import CSS themes from the Themes menu.','문서의 색과 글꼴을 바꿉니다. 테마 메뉴에서 사용자 CSS 테마를 가져오고 관리할 수 있습니다.'],
  theme:['Controls system light/dark appearance. A document theme can use its own colors.','시스템의 밝은·어두운 화면을 따를지 선택합니다. 문서 테마는 자체 색을 사용할 수 있습니다.'],
  fontFamily:['Use the theme font, or override it for your document.','테마의 글꼴을 쓰거나 문서 글꼴을 따로 선택합니다.'],
  documentWidth:['Limits the text column width. The page remains centered.','본문의 최대 너비를 정합니다. 문서는 화면 가운데에 놓입니다.'],
  focus:['Dims other paragraphs while you edit the current paragraph.','편집 중인 문단 외의 문단을 흐리게 표시합니다.'],
  typewriter:['Keeps the line you are typing near the center of the window.','입력 중인 줄이 창의 가운데에 머물도록 스크롤합니다.'],
  mode:['Write: edit with formatting. Markdown Source: see all markup. Preview: read without editing.','작성은 서식을 보며 편집합니다. Markdown 원문은 모든 기호를 표시합니다. 미리보기는 편집하지 않고 읽습니다.'],
  wrap:['Wraps long source lines to the window width; it does not add newlines to the file.','긴 원문 줄을 창 너비에 맞춰 보여 줍니다. 파일에 줄바꿈을 추가하지 않습니다.'],
  lineNumbers:['Shows line numbers when viewing Markdown source.','Markdown 원문을 볼 때 줄 번호를 표시합니다.'],
  tabSize:['Sets the number of spaces used for indentation.','들여쓰기에 사용할 공백 수를 정합니다.'],
  spellcheck:['Marks possible spelling errors with a red underline. Suggestions never replace text without your choice.','맞춤법 오류 후보에 빨간 밑줄을 표시합니다. 교정안을 선택하기 전에는 내용을 바꾸지 않습니다.'],
  grammarCheck:['Marks supported grammar and spacing suggestions with a blue underline.','지원하는 문법·띄어쓰기 교정 후보에 파란 밑줄을 표시합니다.'],
  spellLanguage:['Select the dictionary used to check words. Korean checks supplement the system dictionary with local rules.','검사에 사용할 언어를 정합니다. 한국어 검사는 시스템 사전과 앱의 로컬 규칙을 함께 사용합니다.'],
  personalDictionary:['One accepted word per line. These words will not be marked as misspellings.','줄마다 허용할 단어를 하나씩 입력합니다. 여기에 있는 단어는 오류로 표시하지 않습니다.'],
  pandocPath:['Inkleaf includes a converter. Set a path only to use a different Pandoc installation.','앱에 변환기가 포함되어 있습니다. 다른 Pandoc을 쓰려는 경우에만 경로를 입력합니다.'],
  mathNumbering:['Adds equation numbers to supported display-math environments.','지원하는 수식 블록에 수식 번호를 붙입니다.'],
  mathPhysics:['Enables additional physics notation in TeX equations.','TeX 수식에서 물리 표기 명령을 사용할 수 있게 합니다.'],
  imageUploaderPath:['Optional external program for uploading images. Local image insertion works without it.','이미지 업로드에 쓸 외부 프로그램입니다. 로컬 이미지 삽입에는 필요하지 않습니다.'],
  imageUploaderArguments:['Advanced: arguments passed to your uploader as a JSON list.','고급 설정: 업로드 프로그램에 전달할 인수를 JSON 목록으로 입력합니다.'],
  customCSS:['Advanced: adds your own styles after the selected theme.','고급 설정: 선택한 테마 위에 개인 스타일을 추가합니다.']
};
export function organizeSettings(dialog:Modal,language:'en'|'ko',selected='general'):void {
  dialog.element.classList.add('settings-dialog');
  let navigation=dialog.body.querySelector<HTMLElement>('.settings-navigation'),panels=dialog.body.querySelector<HTMLElement>('.settings-panels');
  if(!navigation){
    const fields=[...dialog.body.children];dialog.body.replaceChildren();navigation=document.createElement('nav');navigation.className='settings-navigation';navigation.setAttribute('role','tablist');navigation.setAttribute('aria-label','Settings categories');
    panels=document.createElement('div');panels.className='settings-panels';dialog.body.append(navigation,panels);
    for(const category of categories){const tab=document.createElement('button');tab.type='button';tab.dataset.settingsCategory=category.id;tab.id='settings-tab-'+category.id;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','settings-panel-'+category.id);tab.addEventListener('click',()=>choose(category.id));navigation.append(tab);const panel=document.createElement('section');panel.id='settings-panel-'+category.id;panel.dataset.settingsPanel=category.id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);panels.append(panel);}
    const scope=document.createElement('div');scope.className='settings-scope';panels.prepend(scope);
    for(const field of fields){if(field.querySelector('[data-document-preference-scope]')||field.hasAttribute('data-scope-note')){scope.append(field);continue;}const key=field.querySelector<HTMLElement>('[data-setting]')?.dataset.setting ?? (field.querySelector('[data-final-newline]')?'finalNewline':'');const category=field.hasAttribute('data-proofreading-status')?'proofreading':field.hasAttribute('data-uploader-note')?'images':categories.find(category=>category.keys.includes(key))?.id??'general';panels.querySelector(`[data-settings-panel="${category}"]`)!.append(field);if(key&&hints[key]){const note=document.createElement('small');note.dataset.settingHint=key;note.className='setting-hint';note.id='setting-hint-'+key;if(key==='appIcon')field.setAttribute('aria-describedby',note.id);field.append(note);}}
    navigation.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const tabs=[...navigation!.querySelectorAll<HTMLButtonElement>('button')],index=tabs.indexOf(document.activeElement as HTMLButtonElement),next=tabs[(index+(['ArrowUp','ArrowLeft'].includes(event.key)?-1:1)+tabs.length)%tabs.length];next.click();next.focus();});
  }
  function choose(id:string){for(const tab of navigation!.querySelectorAll<HTMLButtonElement>('button')){const active=tab.dataset.settingsCategory===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}for(const panel of panels!.querySelectorAll<HTMLElement>('[data-settings-panel]'))panel.hidden=panel.dataset.settingsPanel!==id;dialog.element.dataset.settingsCategory=id;}
  for(const category of categories)navigation.querySelector(`[data-settings-category="${category.id}"]`)!.textContent=language==='ko'?category.ko:category.en;
  navigation.setAttribute('aria-label',language==='ko'?'설정 분류':'Settings categories');
  for(const hint of panels!.querySelectorAll<HTMLElement>('[data-setting-hint]'))hint.textContent=hints[hint.dataset.settingHint!]![language==='ko'?1:0];
  choose(dialog.element.dataset.settingsCategory??selected);
}
