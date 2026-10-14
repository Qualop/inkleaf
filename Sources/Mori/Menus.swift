import AppKit
import DocumentCore

@MainActor
final class Menus: NSObject {
    private static var language = "ko"
    private static weak var installed: Menus?
    private let send: (NativeCommand) -> Void
    private var commands: [Int: NativeCommand] = [:]
    private var nextTag = 1
    private var itemTitles: [(NSMenuItem, String, String)] = []
    private var menuTitles: [(NSMenu, String, String)] = []
    private var servicesMenu: NSMenu?
    private var windowMenu: NSMenu?

    init(send: @escaping (NativeCommand) -> Void) { self.send = send }

    static func setLanguage(_ language: String) {
        self.language = language == "en" ? "en" : "ko"
        installed?.applyLanguage()
    }

    func install() {
        let bar = makeMenu()
        NSApplication.shared.servicesMenu = servicesMenu
        NSApplication.shared.windowsMenu = windowMenu
        NSApplication.shared.mainMenu = bar
    }

    func makeMenu() -> NSMenu {
        commands.removeAll()
        nextTag = 1
        itemTitles.removeAll()
        menuTitles.removeAll()
        Self.installed = self
        let bar = NSMenu()
        let app = submenu("Inkleaf", in: bar)
        native("About Inkleaf", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), in: app)
        app.addItem(.separator())
        command("Settings…", "settings", key: ",", in: app)
        let language = submenu("Language", in: app)
        command("한국어", "language", value: .string("ko"), in: language)
        command("English", "language", value: .string("en"), in: language)
        app.addItem(.separator())
        let services = submenu("Services", in: app)
        servicesMenu = services
        app.addItem(.separator())
        native("Hide Inkleaf", action: #selector(NSApplication.hide(_:)), key: "h", in: app)
        native("Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), key: "h", modifiers: [.command, .option], in: app)
        native("Show All", action: #selector(NSApplication.unhideAllApplications(_:)), in: app)
        app.addItem(.separator())
        native("Quit Inkleaf", action: #selector(NSApplication.terminate(_:)), key: "q", in: app)

        let file = submenu("File", in: bar)
        command("New", "new", key: "n", in: file)
        command("New Window", "newWindow", key: "n", modifiers: [.command, .shift], in: file)
        command("Open…", "open", key: "o", in: file)
        command("Open Folder…", "openFolder", key: "o", modifiers: [.command, .shift], in: file)
        command("Quick Open…", "quickOpen", key: "o", modifiers: [.command, .option], in: file)
        command("Pin / Unpin Folder", "pin-folder", in: file)
        file.addItem(.separator())
        command("Close Document", "close-document", key: "w", in: file)
        command("Close All Documents", "close-all", key: "w", modifiers: [.command, .option], in: file)
        command("Reopen Closed Document", "reopen-closed", key: "t", modifiers: [.command, .shift], in: file)
        file.addItem(.separator())
        command("Save", "save", key: "s", in: file)
        command("Save As…", "saveAs", key: "s", modifiers: [.command, .shift], in: file)
        command("Save All", "save-all", key: "s", modifiers: [.command, .option], in: file)
        command("Duplicate", "duplicate", in: file)
        command("Document Properties…", "statistics", in: file)
        command("Document File Tools…", "document-files", in: file)
        command("Recover Unsaved Documents…", "recoveries", in: file)
        file.addItem(.separator())
        command("Import Document…", "import", in: file)
        let exports = submenu("Export", in: file)
        for (label, format) in [("HTML…", "html"), ("Plain Text…", "txt"), ("PDF…", "pdf"), ("PNG…", "png"),
                                ("JPEG…", "jpeg"), ("SVG…", "svg"), ("LaTeX…", "latex"), ("Word (DOCX)…", "docx"),
                                ("EPUB…", "epub"), ("OpenDocument…", "odt"), ("RTF…", "rtf"), ("reStructuredText…", "rst"),
                                ("Textile…", "textile"), ("OPML…", "opml"), ("MediaWiki…", "wiki")] {
            command(label, "export", value: .string(format), in: exports)
        }
        command("Export Options…", "export-options", in: file)
        command("Repeat Export", "repeat-export", in: file)
        command("Print…", "print", key: "p", in: file)
        file.addItem(.separator())
        native("Close Window", action: #selector(NSWindow.performClose(_:)), key: "w", modifiers: [.command, .shift], in: file)

        let edit = submenu("Edit", in: bar)
        command("Undo", "undo", key: "z", in: edit)
        command("Redo", "redo", key: "z", modifiers: [.command, .shift], in: edit)
        edit.addItem(.separator())
        native("Cut", action: #selector(NSText.cut(_:)), key: "x", in: edit)
        native("Copy", action: #selector(NSText.copy(_:)), key: "c", in: edit)
        native("Paste", action: #selector(NSText.paste(_:)), key: "v", in: edit)
        command("Paste as Plain Text", "pastePlain", key: "v", modifiers: [.command, .shift], in: edit)
        command("Paste Rich Text", "paste-rich", in: edit)
        command("Paste Clipboard Image", "paste-image", in: edit)
        native("Select All", action: #selector(NSText.selectAll(_:)), key: "a", in: edit)
        let copy = submenu("Copy As", in: edit)
        for (label, type) in [("Markdown", "copyMarkdown"), ("HTML", "copyHTML"), ("Plain Text", "copyPlain")] {
            command(label, type, in: copy)
        }
        edit.addItem(.separator())
        let find = submenu("Find", in: edit)
        command("Find…", "find", key: "f", in: find)
        command("Next Match", "next-match", key: "g", in: find)
        command("Previous Match", "previous-match", key: "g", modifiers: [.command, .shift], in: find)
        command("Find and Replace…", "replace", key: "f", modifiers: [.command, .option], in: find)
        command("Replace Next", "replace-one", in: find)
        command("Replace All", "replace-all", in: find)
        find.addItem(.separator())
        command("Search Folder…", "searchWorkspace", key: "f", modifiers: [.command, .shift], in: find)
        command("Move Line Up", "moveLineUp", key: String(UnicodeScalar(NSUpArrowFunctionKey)!), modifiers: [.option], in: edit)
        command("Move Line Down", "moveLineDown", key: String(UnicodeScalar(NSDownArrowFunctionKey)!), modifiers: [.option], in: edit)
        let delete = submenu("Delete", in: edit)
        command("Delete Block", "deleteBlock", in: delete)
        command("Delete Word", "deleteWord", in: delete)
        edit.addItem(.separator())
        let speech = submenu("Speech", in: edit)
        native("Start Speaking", action: #selector(NSTextView.startSpeaking(_:)), in: speech)
        native("Stop Speaking", action: #selector(NSTextView.stopSpeaking(_:)), in: speech)
        native("Emoji & Symbols", action: #selector(NSApplication.orderFrontCharacterPalette(_:)), in: edit)

        let paragraph = submenu("Paragraph", in: bar)
        for level in 1...6 { command("Heading \(level)", "heading", value: .number(Double(level)), key: String(level), in: paragraph) }
        command("Paragraph", "heading", value: .number(0), key: "0", in: paragraph)
        paragraph.addItem(.separator())
        for (label, type) in [("Insert / Edit Table…", "table"), ("Block Quote", "quote"), ("Bulleted List", "bullet"),
                              ("Numbered List", "ordered"), ("Task List", "task"), ("Toggle Task", "toggleTask")] {
            command(label, type, in: paragraph)
        }
        let alerts = submenu("Alert", in: paragraph)
        for alert in ["note", "tip", "important", "warning", "caution"] { command(alert.capitalized, "alert", value: .string(alert), in: alerts) }
        paragraph.addItem(.separator())
        command("Indent", "indent", key: "]", in: paragraph)
        command("Outdent", "outdent", key: "[", in: paragraph)
        command("Insert Paragraph Before", "insertParagraphBefore", in: paragraph)
        command("Insert Paragraph After", "insertParagraphAfter", in: paragraph)
        paragraph.addItem(.separator())
        command("Horizontal Rule", "horizontalRule", in: paragraph)
        command("Table of Contents", "toc", in: paragraph)
        command("YAML Front Matter", "yaml", in: paragraph)

        let format = submenu("Format", in: bar)
        command("Bold", "bold", key: "b", in: format)
        command("Italic", "italic", key: "i", in: format)
        command("Underline", "underline", key: "u", in: format)
        for (label, type) in [("Strikethrough", "strike"), ("Highlight", "highlight"), ("Superscript", "sup"),
                              ("Subscript", "sub"), ("Comment", "comment")] { command(label, type, in: format) }
        format.addItem(.separator())
        command("Link…", "link", key: "k", in: format)
        command("Reference Link…", "linkReference", in: format)
        command("Footnote", "footnote", in: format)
        let image = submenu("Image", in: format)
        command("Insert Local Image…", "insertImage", in: image)
        command("Insert Image URL…", "image", in: image)
        command("Image Properties and Preview…", "image-properties", in: image)
        command("Paste Clipboard Image", "paste-image", in: image)
        image.addItem(.separator())
        for (label, type) in [("Rename Selected Image…", "rename-image"), ("Move Selected Image…", "move-image"),
                              ("Delete Selected Image…", "delete-image"), ("Copy All Local Images…", "copy-images"),
                              ("Move All Local Images…", "move-images")] { command(label, type, in: image) }
        image.addItem(.separator())
        command("Upload Selected Image", "upload-selected-image", in: image)
        command("Upload All Local Images", "upload-images", in: image)
        command("Reload Images", "reload-images", in: image)
        let syntax = submenu("Image Syntax", in: image)
        for (label, type) in [("Resolve Image References", "resolve-image-references"), ("Images to HTML", "images-to-html"),
                              ("Images to Markdown", "images-to-markdown"), ("Use Relative Image URLs", "relative-image-urls")] {
            command(label, type, in: syntax)
        }
        let code = submenu("Code", in: format)
        command("Inline Code", "code", in: code)
        command("Code Block…", "codeBlock", in: code)
        code.addItem(.separator())
        command("Copy Code Block", "copy-code", in: code)
        command("Auto-indent Selection", "autoindent-selected", in: code)
        command("Auto-indent Document", "autoindent-all", in: code)
        let math = submenu("Math", in: format)
        command("Inline Math", "inlineMath", in: math)
        command("Math Block", "mathBlock", in: math)
        math.addItem(.separator())
        for (label, type) in [("Copy Math as TeX", "copy-math-tex"), ("Copy Math as MathML", "copy-math-mathml"),
                              ("Copy Math as SVG", "copy-math-svg"), ("Save Math as TeX…", "save-math-tex"),
                              ("Save Math as MathML…", "save-math-mathml"), ("Save Math as SVG…", "save-math-svg")] {
            command(label, type, in: math)
        }
        let diagram = submenu("Diagram", in: format)
        command("Copy Diagram as SVG", "copy-diagram-svg", in: diagram)
        command("Save Diagram as SVG…", "save-diagram-svg", in: diagram)
        format.addItem(.separator())
        command("Clear Formatting", "clearFormat", key: "r", modifiers: [.command, .shift], in: format)

        let view = submenu("View", in: bar)
        command("Write", "live", in: view)
        command("Markdown Source", "source", in: view)
        command("Preview", "reading", in: view)
        view.addItem(.separator())
        for (label, type) in [("Focus Mode", "focus"), ("Typewriter Mode", "typewriter"), ("Sidebar", "sidebar"),
                              ("Files", "files"), ("Outline", "outline"), ("Document Statistics", "statistics")] {
            command(label, type, in: view)
        }
        view.addItem(.separator())
        command("Zoom In", "zoomIn", key: "+", in: view)
        command("Zoom Out", "zoomOut", key: "-", in: view)
        command("Actual Size", "zoomReset", key: "0", modifiers: [.command, .option], in: view)
        let appearance = submenu("Appearance", in: view)
        for mode in ["system", "light", "dark"] { command(mode.capitalized, "theme", value: .string(mode), in: appearance) }
        native("Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), key: "f", modifiers: [.command, .control], in: view)

        let proofreading = submenu("Proofreading", in: bar)
        command("Look Up in Dictionary", "dictionary", in: proofreading)
        command("Check Spelling While Typing", "spellcheck", in: proofreading)
        command("Proofreading Settings…", "proofreading-settings", in: proofreading)
        let themes = submenu("Themes", in: bar)
        for (label, id) in [("Default", "default"), ("GitHub", "github"), ("Newsprint", "newsprint"),
                            ("Night", "night"), ("Pixyll", "pixyll"), ("Whitey", "whitey")] {
            command(label, "documentTheme", value: .string(id), in: themes)
        }
        themes.addItem(.separator())
        command("Manage Themes…", "themes", in: themes)
        command("Import Theme…", "import-theme", in: themes)
        command("Open Theme Folder", "theme-folder", in: themes)

        let tools = submenu("Tools", in: bar)
        command("Run External Tool…", "run-tool", in: tools)
        command("Cancel Current Operation", "cancel-job", in: tools)
        command("Check External Changes", "check-files", in: tools)
        let diagnostics = submenu("Diagnostics", in: tools)
        command("Retry Loading Editor", "retry", in: diagnostics)
        command("Dismiss Status Message", "dismiss-message", in: diagnostics)
        let window = submenu("Window", in: bar)
        native("Minimize", action: #selector(NSWindow.performMiniaturize(_:)), key: "m", in: window)
        native("Zoom", action: #selector(NSWindow.performZoom(_:)), in: window)
        window.addItem(.separator())
        native("Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), in: window)
        windowMenu = window
        applyLanguage()
        return bar
    }

    @objc private func invoke(_ sender: NSMenuItem) {
        if let command = commands[sender.tag] { send(command) }
    }
    private func applyLanguage() {
        for (item, english, korean) in itemTitles { item.title = Self.language == "en" ? english : korean }
        for (menu, english, korean) in menuTitles { menu.title = Self.language == "en" ? english : korean }
    }
    private func remember(_ item: NSMenuItem, title: String, korean: String? = nil) {
        itemTitles.append((item, title, korean ?? Self.translate(title)))
    }
    private static func translate(_ title: String) -> String {
        if title.hasPrefix("Heading ") { return "제목 " + title.dropFirst(8) }
        return koreanLabels[title] ?? title
    }
    private func submenu(_ title: String, in parent: NSMenu) -> NSMenu {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let menu = NSMenu(title: title)
        remember(item, title: title)
        menuTitles.append((menu, title, Self.translate(title)))
        item.submenu = menu
        parent.addItem(item)
        return menu
    }
    private func command(_ title: String, _ type: String, value: JSONValue? = nil, key: String = "",
                         modifiers: NSEvent.ModifierFlags = [.command], in menu: NSMenu) {
        let item = NSMenuItem(title: title, action: #selector(invoke(_:)), keyEquivalent: key)
        item.target = self
        item.keyEquivalentModifierMask = modifiers
        item.tag = nextTag
        commands[nextTag] = NativeCommand(type: type, value: value)
        nextTag += 1
        remember(item, title: title, korean: type == "heading" && title == "Paragraph" ? "본문" : nil)
        menu.addItem(item)
    }
    private func native(_ title: String, action: Selector, key: String = "", modifiers: NSEvent.ModifierFlags = [.command], in menu: NSMenu) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        remember(item, title: title)
        menu.addItem(item)
    }
    private static let koreanLabels: [String: String] = [
        "File": "파일", "Edit": "편집", "Paragraph": "문단", "Format": "서식", "View": "보기", "Proofreading": "교정", "Themes": "테마", "Tools": "도구", "Window": "창",
        "About Inkleaf": "Inkleaf에 관하여", "Settings…": "설정…", "Language": "언어", "Services": "서비스", "Hide Inkleaf": "Inkleaf 가리기", "Hide Others": "기타 가리기", "Show All": "모두 보기", "Quit Inkleaf": "Inkleaf 종료",
        "New": "새로 만들기", "New Window": "새 창 열기", "Open…": "열기…", "Open Folder…": "폴더 열기…", "Quick Open…": "빠른 열기…", "Pin / Unpin Folder": "폴더 고정 / 해제",
        "Save": "저장", "Save As…": "별도 저장…", "Save All": "모두 저장", "Duplicate": "복제", "Document Properties…": "문서 속성…", "Document File Tools…": "문서 파일 관리…", "Recover Unsaved Documents…": "저장하지 않은 문서 복구…",
        "Close Document": "문서 닫기", "Close All Documents": "모든 문서 닫기", "Reopen Closed Document": "닫은 문서 다시 열기", "Close Window": "창 닫기",
        "Import Document…": "문서 가져오기…", "Export": "내보내기", "Plain Text…": "일반 텍스트…", "Export Options…": "내보내기 설정…", "Repeat Export": "이전 설정으로 내보내기", "Print…": "프린트…",
        "Undo": "실행 취소", "Redo": "실행 복귀", "Cut": "오려두기", "Copy": "복사하기", "Paste": "붙이기", "Paste as Plain Text": "일반 텍스트로 붙이기", "Paste Rich Text": "서식 있는 텍스트 붙이기", "Paste Clipboard Image": "클립보드 이미지 붙이기", "Select All": "전체 선택",
        "Copy As": "다음 형식으로 복사", "Plain Text": "일반 텍스트", "Find": "찾기", "Find…": "찾기…", "Next Match": "다음 찾기", "Previous Match": "이전 찾기", "Find and Replace…": "찾기 및 바꾸기…", "Replace Next": "다음 바꾸기", "Replace All": "모두 바꾸기", "Search Folder…": "폴더에서 찾기…",
        "Move Line Up": "줄 위로 이동", "Move Line Down": "줄 아래로 이동", "Delete": "삭제", "Delete Block": "블록 삭제", "Delete Word": "단어 삭제",
        "Insert / Edit Table…": "표 삽입 / 편집…", "Block Quote": "인용구", "Bulleted List": "순서 없는 목록", "Numbered List": "순서 있는 목록", "Task List": "작업 목록", "Toggle Task": "작업 상태 토글",
        "Table of Contents": "목차", "YAML Front Matter": "YAML 말머리", "Horizontal Rule": "수평선", "Alert": "알림", "Note": "노트 블록", "Tip": "팁 블록", "Important": "중요 블록", "Warning": "경고 블록", "Caution": "주의 블록",
        "Indent": "들여쓰기", "Outdent": "내어쓰기", "Insert Paragraph Before": "앞에 본문 삽입", "Insert Paragraph After": "뒤에 본문 삽입",
        "Bold": "굵게", "Italic": "기울이기", "Underline": "밑줄", "Strikethrough": "취소선", "Highlight": "강조", "Superscript": "위 첨자", "Subscript": "아래 첨자", "Comment": "주석", "Link…": "하이퍼링크…", "Reference Link…": "참조 링크…", "Footnote": "각주", "Clear Formatting": "서식 삭제",
        "Code": "코드", "Inline Code": "인라인 코드", "Code Block…": "코드 블록…", "Copy Code Block": "코드 내용 복사", "Auto-indent Selection": "선택한 코드 자동 들여쓰기", "Auto-indent Document": "전체 코드 자동 들여쓰기",
        "Math": "수식", "Inline Math": "인라인 수식", "Math Block": "수식 블록", "Copy Math as TeX": "수식을 TeX로 복사", "Copy Math as MathML": "수식을 MathML로 복사", "Copy Math as SVG": "수식을 SVG로 복사", "Save Math as TeX…": "수식을 TeX로 저장…", "Save Math as MathML…": "수식을 MathML로 저장…", "Save Math as SVG…": "수식을 SVG로 저장…",
        "Diagram": "다이어그램", "Copy Diagram as SVG": "다이어그램을 SVG로 복사", "Save Diagram as SVG…": "다이어그램을 SVG로 저장…",
        "Image": "이미지", "Insert Local Image…": "로컬 이미지 삽입…", "Insert Image URL…": "이미지 URL 삽입…", "Image Properties and Preview…": "이미지 속성 및 미리보기…", "Rename Selected Image…": "선택한 이미지 이름 변경…", "Move Selected Image…": "선택한 이미지 이동…", "Delete Selected Image…": "선택한 이미지 삭제…",
        "Copy All Local Images…": "모든 로컬 이미지 복사…", "Move All Local Images…": "모든 로컬 이미지 이동…", "Upload Selected Image": "선택한 이미지 업로드", "Upload All Local Images": "모든 로컬 이미지 업로드", "Reload Images": "모든 이미지 다시 불러오기", "Image Syntax": "이미지 구문", "Resolve Image References": "이미지 참조를 URL로 전환", "Images to HTML": "이미지를 HTML 구문으로 전환", "Images to Markdown": "이미지를 Markdown 구문으로 전환", "Use Relative Image URLs": "상대 이미지 URL 사용",
        "Write": "작성", "Markdown Source": "Markdown 원문", "Preview": "미리보기", "Focus Mode": "포커스 모드", "Typewriter Mode": "타자기 모드", "Sidebar": "사이드바", "Files": "파일 목록", "Outline": "개요", "Document Statistics": "문서 통계",
        "Zoom In": "확대", "Zoom Out": "축소", "Actual Size": "실제 크기", "Appearance": "화면 모드", "System": "시스템 설정", "Light": "밝게", "Dark": "어둡게", "Full Screen": "전체 화면",
        "Look Up in Dictionary": "사전에서 찾기", "Check Spelling While Typing": "입력하는 동안 맞춤법 검사", "Proofreading Settings…": "교정 설정…",
        "Speech": "말하기", "Start Speaking": "말하기 시작", "Stop Speaking": "말하기 중단", "Emoji & Symbols": "이모지 및 기호",
        "Default": "기본", "Manage Themes…": "테마 관리…", "Import Theme…": "테마 가져오기…", "Open Theme Folder": "테마 폴더 열기",
        "Run External Tool…": "외부 도구 실행…", "Cancel Current Operation": "현재 작업 취소", "Check External Changes": "외부 변경 확인", "Diagnostics": "진단", "Retry Loading Editor": "편집기 불러오기 재시도", "Dismiss Status Message": "상태 메시지 닫기",
        "Minimize": "최소화", "Zoom": "확대/축소", "Bring All to Front": "모두 앞으로 가져오기"
    ]
}
