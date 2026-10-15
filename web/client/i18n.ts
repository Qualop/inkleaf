export type UILanguage='en'|'ko';

const korean:Record<string,string>={
  'Done':'완료','Look Up':'사전에서 찾기',
  'Outline controls':'개요 조작','Filter headings':'제목 필터','Search all headings':'모든 제목 검색','Maximum heading level':'최대 제목 수준','All levels':'모든 수준','Clear Filter':'필터 지우기','Expand All':'모두 펼치기','Collapse All':'모두 접기','Outline headings':'개요 제목',
  'No headings yet. Add a Markdown heading to navigate this document.':'제목이 없습니다. Markdown 제목을 추가하면 문서 안에서 이동할 수 있습니다.','No matching headings. Clear the filter to see the outline.':'일치하는 제목이 없습니다. 필터를 지우면 개요를 볼 수 있습니다.','No headings at this depth. Choose a deeper heading level.':'이 수준에 제목이 없습니다. 더 깊은 제목 수준을 선택하세요.',
  'Search file names':'파일 이름 검색','File name':'파일 이름','No matching files. Open a folder to search more documents.':'일치하는 파일이 없습니다. 폴더를 열면 더 많은 문서를 검색할 수 있습니다.',
  'Insert Table':'표 삽입','Edit Table':'표 편집','Row':'행','Column':'열','Insert row':'행 삽입','Remove row':'행 삭제','Row up':'행 위로 이동','Row down':'행 아래로 이동','Insert column':'열 삽입','Remove column':'열 삭제','Column left':'열 왼쪽으로 이동','Column right':'열 오른쪽으로 이동','Alignment':'정렬','Left':'왼쪽','Center':'가운데','Right':'오른쪽','Apply Table':'표 적용','Language (optional)':'코드 언어 (선택)','Insert Link':'링크 삽입','Insert Image URL':'이미지 URL 삽입','Insert Reference Link':'참조 링크 삽입','Loading preview…':'미리보기 불러오는 중…','Image preview loaded.':'이미지 미리보기를 불러왔습니다.',
  'Use selected document theme':'선택한 문서 테마 사용',
  'Untitled':'새 문서','Write':'작성','Markdown Source':'Markdown 원문','Preview':'미리보기','Editing mode':'편집 방식','Write with formatting, edit Markdown source, or preview without editing.':'작성은 서식을 보며 편집합니다. Markdown 원문은 기호를 표시합니다. 미리보기는 읽기 전용입니다.',
  'Themes':'테마','Themes…':'테마…','Document themes':'문서 테마','Document theme':'문서 테마','Default':'기본','Theme font':'테마 글꼴','Manage Themes…':'테마 관리…','Import CSS Theme…':'CSS 테마 가져오기…','New CSS Theme…':'CSS 테마 만들기…','New CSS Theme':'CSS 테마 만들기','Edit CSS Theme':'CSS 테마 편집','Open Theme Folder':'테마 폴더 열기','Refresh Themes':'테마 새로고침','Edit CSS':'CSS 편집','Delete Theme':'테마 삭제','Save Theme':'테마 저장','Theme name':'테마 이름','Stylesheet':'스타일시트',
  'Clean document, follows the system appearance':'시스템 화면을 따르는 기본 문서','Clear headings, sans-serif text, blue links':'명확한 제목·기본 글꼴·파란 링크','Warm paper and serif text':'따뜻한 종이색과 세리프 글꼴','Soft dark background for evening writing':'저녁에 쓰기 편한 어두운 배경','Serif paragraphs and compact sans-serif headings':'세리프 본문과 간결한 제목','Quiet neutral page and restrained headings':'중립색 문서와 차분한 제목',
  'Reopen documents on startup':'시작할 때 이전 문서 열기','Keep unsaved drafts when quitting':'종료할 때 미저장 문서 보관','Check grammar and spacing':'문법·띄어쓰기 검사','Dictionary language':'검사 언어','Personal dictionary':'개인 사전','Automatic':'자동','Korean':'한국어','Dictionary':'사전','Lookup':'사전에서 찾기',
  'Draft':'임시 문서','Draft kept':'임시 보관됨','Draft changes':'임시 보관 중','File saved':'파일에 저장됨','File changes not saved':'파일 저장 전','Keep Draft':'임시 보관하고 닫기','Save to File and Close':'파일에 저장하고 닫기','Discard and Close':'내용을 버리고 닫기','File changes are kept as a local draft.':'변경 내용을 앱의 임시 문서로 보관했습니다.',
  'Superscript':'윗첨자','Subscript':'아랫첨자','Comment':'주석','Inline Math':'인라인 수식','Heading':'제목','Quote':'인용','Bullet List':'글머리 목록','Numbered List':'번호 목록','Task List':'작업 목록','Toggle Task':'완료 상태 전환','Indent':'들여쓰기','Outdent':'내어쓰기','Horizontal Rule':'구분선','Code Block':'코드 블록','Math Block':'수식 블록','Contents':'목차','Front Matter':'YAML 머리말','Alert':'알림 블록','Footnote':'각주','Reference Link':'참조 링크','Link':'링크','Image URL':'이미지 URL','Clear Formatting':'서식 지우기','Paragraph Before':'앞에 문단 삽입','Paragraph After':'뒤에 문단 삽입','Move Line Up':'줄을 위로 이동','Move Line Down':'줄을 아래로 이동','Delete Block':'문단 삭제','Delete Word':'단어 삭제',
  'Table…':'표…','Insert Local Image…':'로컬 이미지 삽입…','Auto-indent Selection':'선택 영역 자동 들여쓰기','Auto-indent Document':'문서 자동 들여쓰기','Copy Code Block':'코드 내용 복사','Save As…':'다른 이름으로 저장…','Document File Tools…':'문서 파일 관리…','Repeat Export':'이전 설정으로 내보내기','Copy Math as TeX':'수식을 TeX로 복사','Copy Math as MathML':'수식을 MathML로 복사','Copy Math as SVG':'수식을 SVG로 복사','Save Math as TeX…':'수식을 TeX로 저장…','Save Math as MathML…':'수식을 MathML로 저장…','Save Math as SVG…':'수식을 SVG로 저장…','Copy Diagram as SVG':'도식을 SVG로 복사','Save Diagram as SVG…':'도식을 SVG로 저장…','Duplicate':'복제','Copy Markdown':'Markdown 복사','Copy Plain Text':'일반 텍스트 복사','Copy HTML':'HTML 복사','Paste Plain Text':'일반 텍스트 붙여넣기','Paste Rich Text':'서식 있는 텍스트 붙여넣기','Paste Clipboard Image':'클립보드 이미지 붙여넣기','Find and Replace':'찾기 및 바꾸기','Run Tool…':'외부 도구 실행…','Import Document…':'문서 가져오기…','Upload Local Images':'로컬 이미지 업로드','Upload Selected Image':'선택한 이미지 업로드','Reload Images':'이미지 새로고침','Image Properties and Preview…':'이미지 속성·미리보기…','Rename Selected Image…':'선택한 이미지 이름 변경…','Move Selected Image…':'선택한 이미지 이동…','Delete Selected Image…':'선택한 이미지 삭제…','Copy All Local Images…':'모든 로컬 이미지 복사…','Move All Local Images…':'모든 로컬 이미지 이동…','Resolve Image References':'참조 이미지를 일반 링크로 변환','Images to HTML':'이미지를 HTML 구문으로','Images to Markdown':'이미지를 Markdown 구문으로','Use Relative Image URLs':'상대 이미지 경로 사용',
  'The file changed on disk':'다른 앱에서 파일이 변경되었습니다','The save destination conflicts':'저장할 파일이 변경되었습니다','Choose Destination Again':'저장 위치 다시 선택','Reload Disk':'파일의 내용을 다시 읽기','Save Separate Copy':'별도 사본 저장','Overwrite Disk':'파일 덮어쓰기',
  'Cancelled.':'취소했습니다.','Copied to the clipboard.':'클립보드에 복사했습니다.','Code copied.':'코드를 복사했습니다.','Images reloaded.':'이미지를 다시 불러왔습니다.','Enter text to search this document.':'이 문서에서 찾을 내용을 입력하세요.','Open a folder to browse files.':'폴더를 열면 파일 목록을 볼 수 있습니다.',
  'Save this document or discard its current edits before closing.':'파일에 저장하거나 임시 문서로 보관할 수 있습니다. 내용을 버리면 현재 변경 사항을 삭제합니다.',
  'Your edits are still open. Reload the disk version, save a separate copy, or explicitly overwrite the changed file.':'현재 편집 내용은 보존되어 있습니다. 파일을 다시 읽거나, 별도 사본으로 저장하거나, 변경된 파일을 덮어쓸 수 있습니다.',
  'Finish composing text before closing this window.':'한글 입력을 마친 다음 창을 닫아 주세요.','Documents changed while preparing to close. Try again after editing.':'종료 준비 중 문서가 변경되었습니다. 입력을 마친 뒤 다시 종료해 주세요.',
  'Document menu':'문서 메뉴','Document statistics':'문서 통계','Document properties':'문서 속성','Open documents':'열린 문서','Folder options':'폴더 옵션','Open Folder…':'폴더 열기…','Open…':'열기…','Export…':'내보내기…','Settings…':'설정…',
  'Automatically save changed files':'변경한 파일 자동 저장','Watch files for external changes':'외부 파일 변경 감시','Check External Changes':'외부 변경 확인',
  'Sidebar':'사이드바','New':'새 문서','Open':'열기','Folder':'폴더','Save':'저장','Format':'서식','Insert':'삽입','Edit':'편집','View':'보기',
  'Live':'작성','Source':'Markdown 원문','Reading':'미리보기','Export':'내보내기','Settings':'설정','Files':'파일','Outline':'개요','Search':'검색',
  'Quick Open':'빠른 열기','Find':'찾기','Replace':'바꾸기','Case':'대소문자','Regex':'정규식','Word':'단어','Previous':'이전','Next':'다음','Replace All':'모두 바꾸기','Search Folder':'폴더 검색',
  'Encoding':'문자 인코딩','Line endings':'줄 끝 형식','Focus':'집중','Typewriter':'타자기 모드','Dismiss':'닫기','Retry':'다시 시도','Cancel':'취소','Close':'닫기',
  'Saved':'저장됨','Saving…':'저장 중…','Unsaved changes':'저장하지 않은 변경','Not saved':'저장 전','No document open':'열린 문서 없음',
  'Pin Folder':'폴더 고정','Unpin Folder':'폴더 고정 해제','Sort files':'파일 정렬','Name':'이름','Recently modified':'최근 수정순','Size':'크기',
  'Use settings only for this document':'이 문서에만 설정 적용','Reset Document Settings':'문서 설정 초기화','Reset Settings':'전체 설정 초기화',
  'App language (all documents)':'앱 언어 (모든 문서)','English':'영어','Appearance':'화면 모양','System':'시스템','Light':'밝게','Dark':'어둡게',
  'App icon (all documents)':'앱 아이콘 (모든 문서)','Black Ink':'검은 잉크','Green Leaf':'초록 잎',
  'Document scope applies to document appearance, editing and proofreading. App icon, language and startup behavior apply to the whole app.':'문서별 설정은 문서 모양·편집·맞춤법 검사에 적용됩니다. 앱 아이콘·언어·시작 동작은 앱 전체에 적용됩니다.',
  'Font':'글꼴','System Sans':'시스템 기본 글꼴','Serif':'세리프','Monospace':'고정폭 글꼴','Text size':'글자 크기','Document width':'문서 너비','Line height':'줄 높이',
  'Wrap source lines':'소스 줄바꿈','Source line numbers':'소스 줄 번호','Focus current paragraph':'현재 문단에 집중','Keep cursor centered':'커서를 가운데 유지',
  'Free Pandoc executable path (optional)':'Pandoc 실행 파일 경로 (선택)','Math equation numbering':'수식 번호','None':'없음','AMS numbered environments':'AMS 번호 환경','All display equations':'모든 블록 수식',
  'Physics TeX package':'Physics TeX 패키지','Custom image uploader executable (absolute path)':'이미지 업로더 실행 파일 (절대 경로)','Uploader argv (JSON string array)':'업로더 인수 (JSON 문자열 배열)',
  'Tab width':'탭 너비','Bold marker':'굵게 표시 기호','Italic marker':'기울임 표시 기호','Bullet marker':'목록 표시 기호','Complete brackets and quotes':'괄호와 따옴표 자동 완성',
  'Default code language':'기본 코드 언어','Remember last code language':'최근 코드 언어 기억','Check spelling while typing':'입력 중 맞춤법 검사','Complete named emoji':'이모지 이름 자동 완성',
  'Convert pasted rich text to Markdown':'붙여넣은 서식 있는 텍스트를 Markdown으로 변환','Automatically link URLs':'URL 자동 링크','CommonMark syntax (math stays enabled)':'CommonMark 문법 (수식 유지)',
  'Smart punctuation in preview':'미리보기 문장 부호 변환','Render embedded HTML':'HTML 렌더링','Custom stylesheet':'사용자 스타일시트','Document final newline':'문서 마지막 줄바꿈',
  'Export Document':'문서 내보내기','Preset':'프리셋','Current options':'현재 옵션','Title':'제목','Author':'작성자','Include contents':'목차 포함','Dark export background':'어두운 내보내기 배경',
  'Paper':'용지','Margin (mm)':'여백 (mm)','Image/page width (px)':'이미지/페이지 너비 (px)','JPEG quality (0–1)':'JPEG 품질 (0–1)','Page break before major headings':'큰 제목 앞에서 페이지 나누기','Header':'머리말','Footer':'꼬리말',
  'Save Preset':'프리셋 저장','Rename Preset':'프리셋 이름 변경','Delete Preset':'프리셋 삭제','Save Export Preset':'내보내기 프리셋 저장','Rename Export Preset':'내보내기 프리셋 이름 변경','Delete Export Preset':'내보내기 프리셋 삭제','Preset name':'프리셋 이름','New preset name':'새 프리셋 이름',
  'Image Properties':'이미지 속성','Alternative text':'대체 텍스트','Width (pixels)':'너비 (픽셀)','Height (pixels)':'높이 (픽셀)','Fit':'화면에 맞춤','Zoom Out':'축소','Zoom In':'확대','Apply Image Properties':'이미지 속성 적용',
  'Apply':'적용','Undo':'실행 취소','Redo':'다시 실행','Bold':'굵게','Italic':'기울임','Underline':'밑줄','Strikethrough':'취소선','Highlight':'강조','Inline Code':'인라인 코드',
  'Document File Tools':'문서 파일 도구','Rename File':'파일 이름 변경','Move File':'파일 이동','Move to Trash':'휴지통으로 이동',
  'Recover Unsaved Documents':'저장하지 않은 문서 복구','Close unsaved document?':'저장하지 않은 문서를 닫을까요?','Save and Close':'저장하고 닫기','Discard Changes':'변경 버리기',
  'Unsaved documents':'저장하지 않은 문서','Keep Recovery':'복구본 유지','Save All':'모두 저장','Run External Tool':'외부 도구 실행','Executable path':'실행 파일 경로','Arguments':'인수','Run':'실행','Replace Document':'문서 내용 바꾸기',
  'Document tools':'문서 도구','Document view':'문서 보기','Document encoding':'문서 인코딩','Preview zoom controls':'미리보기 확대 도구','Image preview':'이미지 미리보기',
};
for(const title of ['Themes','New CSS Theme','Edit CSS Theme','Delete Theme','Dictionary','Settings','Export Document','Image Properties','Quick Open','Document File Tools','Recover Unsaved Documents','Unsaved documents','Run External Tool'])korean[`Close ${title}`]=`${korean[title]} 닫기`;
const protectedContent='.editor-host,.reading,[data-outline-row],[data-outline-current],.file-tree,.document-tabs,.quick-results,[data-user-content],[data-search-results],style,script,textarea,code,pre';
const chromeSelectors='.sidebar-tabs button,.sidebar-section-title,[data-folder-label],.folder-options summary,.folder-options label,.search-fields label,.search-fields p,.statusbar summary,.statusbar label,.statusbar button,.mode-hint,[data-action],dialog h2,dialog p,dialog button,dialog legend,dialog label > span,dialog input,.theme-list strong,.theme-list small,dialog select option,select[data-setting] option,select[data-control] option,.outline-controls,.outline-controls label,.outline-controls button,.outline-controls input,.outline-controls select,.outline-controls option,.outline nav,[data-outline-count],[data-outline-empty],[data-outline-show-more],[data-save-state],[data-save-indicator],[data-statistics],[data-selection],[data-message]';
type Translation={original:string;written:string};

/** Exact chrome labels only: document text, filenames, outline entries and input values are excluded. */
export class UILocalizer {
  private root:HTMLElement;
  private language:UILanguage='en';
  private texts=new WeakMap<Node,Translation>();
  private attrs=new WeakMap<Element,Map<string,Translation>>();
  private observer:MutationObserver;
  constructor(root:HTMLElement){
    this.root=root;const Observer=root.ownerDocument.defaultView!.MutationObserver;
    this.observer=new Observer(records=>{if(records.some(record=>!this.protected(record.target)))this.refresh();});
    this.observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','title','placeholder']});
  }
  private protected(node:Node):boolean {const element=node.nodeType===1?node as Element:node.parentElement;return !!element?.closest(protectedContent);}
  private translate(value:string):string {const trimmed=value.trim();if(this.language!=='ko')return value;if(korean[trimmed])return value.replace(trimmed,korean[trimmed]);return value.replace(/^Heading ([1-6])$/,'제목 $1').replace(/^Through heading level ([1-6])$/,'제목 수준 $1까지').replace(/^Show (\d+) more headings$/,'제목 $1개 더 보기').replace(/^Showing (\d+) of (\d+) headings \((\d+) total\)\.$/,'제목 $2개 중 $1개 표시 (전체 $3개).').replace(/^(\d+) match(?:es)?; showing (\d+) of (\d+) headings with ancestor context \((\d+) total\)\. Search includes all depths\.$/,'검색 결과 $1개; 상위 제목을 포함한 $3개 중 $2개 표시 (전체 $4개). 모든 수준을 검색합니다.').replace(/^Alert (note|tip|important|warning|caution)$/,(all,kind)=>'알림 '+({note:'참고',tip:'팁',important:'중요',warning:'경고',caution:'주의'} as Record<string,string>)[kind]).replace(/^(\d[\d,]*) selected$/,'$1자 선택').replace(/^(\d[\d,]*) words · (\d[\d,]*) characters · (\d[\d,]*) lines · (\d+) min$/,'$1단어 · $2자 · $3줄 · 약 $4분');}
  setLanguage(language:UILanguage):void {this.language=language;this.root.lang=language;this.refresh();}
  private refresh():void {
    for(const element of this.root.querySelectorAll<HTMLElement>(chromeSelectors)){
      if(this.protected(element))continue;
      for(const node of element.childNodes){
        if(node.nodeType!==3)continue;const value=node.nodeValue ?? '',prior=this.texts.get(node),original=prior && value===prior.written?prior.original:value,written=this.translate(original);
        this.texts.set(node,{original,written});if(value!==written)node.nodeValue=written;
      }
      for(const name of ['aria-label','title','placeholder']){
        const value=element.getAttribute(name);if(value===null)continue;let attributes=this.attrs.get(element);if(!attributes){attributes=new Map();this.attrs.set(element,attributes);}
        const prior=attributes.get(name),original=prior && value===prior.written?prior.original:value,written=this.translate(original);attributes.set(name,{original,written});if(value!==written)element.setAttribute(name,written);
      }
    }
  }
  destroy():void {this.observer.disconnect();}
}
