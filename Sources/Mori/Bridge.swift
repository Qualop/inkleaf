import AppKit
import CoreFoundation
import WebKit
import UniformTypeIdentifiers
import DocumentCore
import ToolCore

struct NativeCommand: Sendable {
    let type: String
    var value: JSONValue? = nil
    var json: JSONValue {
        var object: [String: JSONValue] = ["type": .string(type)]
        if let value { object["value"] = value }
        return .object(object)
    }
}

@MainActor
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var bridge: Bridge?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        bridge?.receive(message)
    }
}

@MainActor
final class Bridge {
    let documents: DocumentStore
    let workspace: WorkspaceStore
    let settings: SettingsStore
    private let pasteboard: NSPasteboard
    private let appIconController: AppIconController
    private let windowSessions:WindowSessionStore
    private let windowID:String
    private let initialSession:WindowSessionContent?
    private let inheritLegacySession:Bool
    private var windowClosing=false
    private var windowClosed=false
    private var lastClientSettings:[String:JSONValue]?
    let runner = ProcessRunner()
    private let webView: WKWebView
    private let dataDirectory: URL
    private let webRoot: URL
    private var documentPaths: [String: String] = [:]
    private var requests: [Int: Task<Void, Never>] = [:]
    private struct Operation {
        let method: String
        let task: Task<JSONValue, any Error>
    }
    private var operations: [UUID: Operation] = [:]
    private var exportJobs = Set<String>()
    private var searches: [String: Task<JSONValue, any Error>] = [:]
    lazy var exporter = ExportController(runner: runner, settings: settings)
    private lazy var themes=ThemeStore(dataDirectory:dataDirectory)
    private let spelling=SpellingService()
    var onReady: (() -> Void)?

    init(webView: WKWebView, options: LaunchOptions,windowSessions:WindowSessionStore?=nil,settingsStore:SettingsStore?=nil,windowID:String=UUID().uuidString,initialSession:WindowSessionContent?=nil,inheritLegacySession:Bool=true,appIconController:AppIconController?=nil,pasteboard:NSPasteboard?=nil) {
        self.webView = webView
        webRoot = options.webRoot.resolvingSymlinksInPath()
        dataDirectory = options.dataDirectory
        documents = DocumentStore(dataDirectory: options.dataDirectory)
        workspace = WorkspaceStore(dataDirectory: options.dataDirectory)
        settings = settingsStore ?? SettingsStore(dataDirectory: options.dataDirectory)
        self.pasteboard = pasteboard ?? .general
        self.appIconController = appIconController ?? AppIconController()
        self.windowSessions=windowSessions ?? WindowSessionStore(dataDirectory:options.dataDirectory)
        self.windowID=windowID;self.initialSession=initialSession;self.inheritLegacySession=inheritLegacySession
    }
    private var currentFrame:WindowFrame?{
        guard let rect=webView.window?.frame else{return nil};let frame=WindowFrame(x:rect.minX,y:rect.minY,width:rect.width,height:rect.height);return frame.isValid ? frame:nil
    }
    func persistWindowFrame()async throws{guard !windowClosing else{return};if let frame=currentFrame{try await windowSessions.updateFrame(id:windowID,frame:frame)}}
    func focusWindow()async throws{guard !windowClosing else{return};try await windowSessions.focus(id:windowID)}
    func removeWindowSession(keepSession:Bool=false,validate:(@MainActor () async -> Bool)?=nil) async throws {
        if windowClosed {return}
        guard !windowClosing else {throw BridgeError.cancelled}
        windowClosing=true
        do {
            let documentMethods:Set<String>=["createDocument","chooseDocument","openDocument","setDocumentFormat","observeDocument","reloadDocument","restoreDocument","closeDocument","saveDocument","saveAs","checkpoint","keepRecovery","import","importDocument","importImages","manageFile"]
            // Drain accepted changes before validating the checkpointed close approval.
            for operation in Array(operations.values) where operation.method == "settings" || documentMethods.contains(operation.method) {
                _ = await operation.task.result
            }
            if let validate,!(await validate()){throw BridgeError.cancelled}
            if !keepSession {
                let previous=try await windowSessions.all().first{$0.id==windowID}
                try await windowSessions.remove(id:windowID)
                if let validate,!(await validate()) {
                    if let previous,case .object(let values)=previous.content.json {try await windowSessions.update(id:windowID,values:values,frame:previous.frame)}
                    throw BridgeError.cancelled
                }
            }
        } catch {windowClosing=false;throw error}
        onReady=nil
        let pending=Array(operations.values)
        for operation in pending {operation.task.cancel()}
        for task in requests.values {task.cancel()}
        for task in searches.values {task.cancel()}
        for id in exportJobs {_ = exporter.cancel(jobId:id)}
        let documentMethods:Set<String>=["createDocument","chooseDocument","openDocument","setDocumentFormat","observeDocument","reloadDocument","restoreDocument","closeDocument","saveDocument","saveAs","checkpoint","keepRecovery","import","importDocument","importImages","manageFile"]
        // Finish accepted document operations before releasing their records; unrelated tools may retain Bridge.
        for operation in pending where documentMethods.contains(operation.method) {
            _ = await operation.task.result
        }
        await documents.closeAll()
        documentPaths.removeAll()
        windowClosed=true
    }
    func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              url.isFileURL, url.resolvingSymlinksInPath().pathComponents.starts(with: webRoot.pathComponents) else { return }
        do {
            let request = try NativeRequest.parse(message.body)
            guard requests[request.id] == nil else {
                reply(.failure(id: request.id, error: BridgeError.invalidRequest("Request ID is already running.")))
                return
            }
            requests[request.id] = Task { [weak self] in
                guard let self else { return }
                defer { requests.removeValue(forKey: request.id) }
                do { reply(.success(id: request.id, result: try await dispatch(request))) }
                catch { reply(.failure(id: request.id, error: error)) }
            }
        } catch {
            // Retain a valid correlation ID even when the remaining envelope is malformed.
            reply(.failure(id: BridgeRequestPolicy.correlationID(message.body), error: error))
        }
    }
    func reply(_ reply: NativeReply) {
        guard !windowClosed else {return}
        guard let script = try? reply.javaScript() else { return }
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
    func command(_ command: NativeCommand) {
        guard !windowClosed else {return}
        guard let data = try? JSONSerialization.data(withJSONObject: command.json.foundationValue),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__nativeCommand(\(json));", completionHandler: nil)
    }

    func dispatch(_ request: NativeRequest) async throws -> JSONValue {
        guard !windowClosing else {throw BridgeError.cancelled}
        let token=UUID()
        let task=Task { @MainActor in
            try Task.checkCancellation()
            return try await self.perform(request)
        }
        // Register accepted work before yielding so window close can drain it.
        operations[token]=Operation(method:request.method,task:task)
        defer {operations.removeValue(forKey:token)}
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {task.cancel()}
    }

    private func perform(_ request: NativeRequest) async throws -> JSONValue {
        switch request.method {
        case "bootstrap":
            var preferences=AppIconController.normalizedSettings(try await settings.all())
            appIconController.apply(settings:preferences)
            if let initialSession{preferences["session"]=initialSession.json}
            else if !inheritLegacySession{preferences["session"]=try WindowSessionContent(values:["documents":.array([])]).json}
            lastClientSettings=preferences.filter{$0.key != "session"}
            let recoveries = try await documents.recoveries()
            let result: JSONValue = .object(["unsavedAssetRoot": .string(dataDirectory.appendingPathComponent("unsaved",isDirectory:true).path), "settings": .object(preferences),
                                            "recoveries": try NativeReply.encode(recoveries)])
            // Deliver queued OS open events after the bootstrap response's JavaScript has run.
            Task { @MainActor [weak self] in
                await Task.yield()
                if let self,!self.windowClosed {self.onReady?()}
            }
            return result
        case "createDocument": return try NativeReply.encode(await documents.create(text: request.optionalString("text") ?? ""))
        case "chooseDocument":
            guard let url = await chooseFile(types: [.plainText, .text], title: "Open Document") else { return .null }
            let snapshot = try await documents.open(path: url.path)
            track(snapshot)
            return try NativeReply.encode(snapshot)
        case "openDocument":
            let snapshot = try await documents.open(path: request.string("path"))
            track(snapshot)
            return try NativeReply.encode(snapshot)
        case "setDocumentFormat":
            return try await NativeReply.encode(documents.updateFormat(id:request.string("documentId"),text:request.string("text"),revision:request.integer("revision"),encoding:request.string("encoding")))
        case "observeDocument":
            return try await NativeReply.encode(documents.observe(id: request.string("documentId")))
        case "reloadDocument":
            let snapshot = try await documents.reload(id: request.string("documentId"), revision: request.integer("revision"))
            track(snapshot)
            return try NativeReply.encode(snapshot)
        case "restoreDocument":
            let id=try request.string("documentId")
            let snapshot:DocumentSnapshot
            if request.args["path"] != nil {snapshot=try await documents.restoreSession(id:id,path:request.optionalString("path"))}
            else {snapshot=try await documents.restore(id:id)}
            track(snapshot)
            return try NativeReply.encode(snapshot)
        case "keepRecovery":
            return try await NativeReply.encode(documents.keepRecovery(id:request.string("documentId"),revision:request.integer("revision")))
        case "closeDocument":
            let id = try request.string("documentId")
            let keep=try request.boolean("keepRecovery"),discard=try request.boolean("discardRecovery")
            guard !(keep && discard) else{throw BridgeError.invalidRequest("Choose keep or discard for a document close.")}
            try await documents.close(id:id,discardRecovery:discard,keepRevision:keep ? request.integer("revision"):nil)
            documentPaths.removeValue(forKey: id)
            return .null
        case "chooseWorkspace":
            guard let url = await chooseFile(directory: true, title: "Open Folder") else { return .null }
            return .string(url.path)
        case "saveDocument", "saveAs":
            return try await save(request)
        case "checkpoint":
            try await documents.checkpoint(id: request.string("documentId"), text: request.string("text"), revision: request.integer("revision"))
            return .null
        case "listDirectory": return try await NativeReply.encode(workspace.listDirectory(path: request.string("path")))
        case "searchWorkspace":
            let jobId = try request.optionalString("jobId") ?? "search-\(request.id)"
            guard searches[jobId] == nil else { throw BridgeError.invalidRequest("Search job is already running.") }
            let task = Task {
                try await NativeReply.encode(workspace.search(path: request.optionalString("path") ?? request.string("root"),
                    query: request.string("query"), caseSensitive: request.boolean("caseSensitive"),
                    regex: request.boolean("regex"),wholeWord:request.boolean("wholeWord"), limit: request.integer("limit", default: 200)))
            }
            searches[jobId] = task
            defer { searches.removeValue(forKey: jobId) }
            return try await task.value
        case "cancelSearch":
            searches[try request.string("jobId")]?.cancel()
            return .null
        case "readAsset":
            let bytes = try await workspace.readAsset(path: request.string("path"), root: request.string("root"))
            return .object(["base64": .string(bytes.base64EncodedString()), "type": .string(mimeType(try request.string("path")))])
        case "importImages": return try await importImages(request)
        case "manageFile":
            let operation=try request.string("operation"),path=try request.string("path"),destination=try request.optionalString("destination")
            if let id=try request.optionalString("documentId") {
                guard ["rename","move","trash"].contains(operation) else {throw BridgeError.unsupported("Unsupported document file operation")}
                let snapshot=try await documents.verifySaved(id:id)
                guard snapshot.path==path else {throw BridgeError.invalidRequest("Managed source does not match the original document binding")}
                let result=try await workspace.manage(operation:operation,path:path,destination:destination)
                let rebound:DocumentSnapshot
                do {rebound=try await documents.rebind(id:id,path:operation=="trash" ? nil : result)}
                catch let bindingError {
                    do {_ = try await workspace.manage(operation:"move",path:result,destination:path)}
                    catch let rollbackError {
                        throw DocumentError.io("\(bindingError.localizedDescription). File remains at \(result); restoring \(path) failed: \(rollbackError.localizedDescription)")
                    }
                    throw bindingError
                }
                if operation=="trash" {documentPaths.removeValue(forKey:id)} else {track(rebound)}
                return .object(["path":.string(result),"document":try NativeReply.encode(rebound)])
            }
            return .string(try await workspace.manage(operation:operation,path:path,destination:destination))
        case "settings":
            let operation = try request.optionalString("operation") ?? (request.args["values"] == nil ? "read" : "write")
            switch operation {
            case "read", "get":
                let current = AppIconController.normalizedSettings(try await settings.all())
                lastClientSettings?["appIcon"] = current["appIcon"]
                return .object(current)
            case "write", "update", "set", "reset":
                guard !windowClosed else{throw BridgeError.cancelled}
                var values=try request.object("values")
                try AppIconController.validate(values["appIcon"])
                if let session=values.removeValue(forKey:"session"){
                    guard case .object(let state)=session else{throw BridgeError.invalidRequest("Window session must be an object.")}
                    try await windowSessions.update(id:windowID,values:state,frame:currentFrame)
                }
                let supplied=values
                if operation != "reset",let previous=lastClientSettings{values=values.filter{previous[$0.key] != $0.value}}
                if operation == "reset" { values["appIcon"] = .string("ink") }
                let updated=AppIconController.normalizedSettings(try await settings.update(values:values));lastClientSettings=supplied
                appIconController.apply(settings:updated)
                return .object(updated)
            default: throw BridgeError.unsupported("Unsupported settings operation: \(operation)")
            }
        case "uiLanguage":
            let language=try request.string("language")
            guard ["ko","en"].contains(language) else{throw BridgeError.invalidRequest("UI language must be ko or en.")}
            Menus.setLanguage(language)
            return .null
        case "themeFiles": return try await themeFiles(request)
        case "proofread":
            switch try request.string("operation") {
            case "check":
                return spelling.check(text:try request.string("text"),language:try request.optionalString("language") ?? "ko",ignoredWords:try request.strings("ignoredWords",default:[]))
            case "lookup": return try await spelling.lookup(text:request.string("text"),in:webView)
            case "learn":
                let word=try request.string("word").trimmingCharacters(in:.whitespacesAndNewlines)
                guard !word.isEmpty,word.utf16.count<=100,!word.contains("\0"),!word.contains("\n"),!word.contains("\r") else{throw BridgeError.invalidRequest("Select a word to add to the personal dictionary.")}
                let preferences=try await settings.all()
                var words:[String]=[]
                if case .array(let items)=preferences["personalDictionary"] {words=items.compactMap{if case .string(let text)=$0{return text};return nil}}
                if !words.contains(word) {words.append(word)}
                guard words.count<=5000 else{throw BridgeError.invalidRequest("Personal dictionary is full.")}
                _=try await settings.update(values:["personalDictionary":.array(words.map(JSONValue.string))])
                return .object(["word":.string(word),"learned":.bool(true),"personalDictionary":.array(words.map(JSONValue.string))])
            default: throw BridgeError.unsupported("Unsupported proofread operation.")
            }
        case "clipboard": return try clipboard(request)
        case "openExternal":
            guard let url = URL(string: try request.string("url")), let scheme = url.scheme?.lowercased(),
                  ["http", "https", "mailto"].contains(scheme) else { throw BridgeError.invalidRequest("Expected an http, https or mailto URL.") }
            guard NSWorkspace.shared.open(url) else { throw BridgeError.unavailable("macOS could not open this URL.") }
            return .null
        case "runTool":
            let timeout = try request.number("timeout", default: 60)
            let maximum = try request.integer("maxOutputBytes", default: 8_388_608)
            guard timeout > 0, timeout <= 3600, maximum > 0, maximum <= 67_108_864 else {
                throw BridgeError.invalidRequest("Tool timeout or output limit is outside the allowed range.")
            }
            return try await NativeReply.encode(runner.run(jobId: request.string("jobId"), executable: request.string("executable"),
                arguments: request.strings("arguments", default: []), input: request.optionalString("input"),
                directory: request.optionalString("directory"), timeout: timeout, maxOutputBytes: maximum))
        case "cancelTool":
            let jobId = try request.string("jobId")
            let priorOutputPath=exporter.committedPath(jobId:jobId)
            let runnerCancelled = await runner.cancel(jobId: jobId)
            let searchCancelled = searches[jobId] != nil
            searches[jobId]?.cancel()
            let exportCancelled = exporter.cancel(jobId: jobId)
            let outputPath=priorOutputPath ?? exporter.committedPath(jobId:jobId)
            return .object(["cancelled": .bool(runnerCancelled || searchCancelled || exportCancelled),"outputCreated":.bool(outputPath != nil),"path":outputPath.map(JSONValue.string) ?? .null])
        case "import", "importDocument": return try await importDocument(request)
        case "export":
            if let kind=try request.optionalString("assetKind") {return try await saveTextAsset(request,kind:kind)}
            let jobId=try request.optionalString("jobId") ?? UUID().uuidString
            var args=request.args;args["jobId"] = .string(jobId)
            guard exportJobs.insert(jobId).inserted else {throw BridgeError.invalidRequest("Export job already exists.")}
            defer{exportJobs.remove(jobId)}
            return try await exporter.export(NativeRequest(id:request.id,method:request.method,args:args), window: webView.window)
        case "print":
            return try await exporter.printHTML(request, window: webView.window)
        case "setWindowTitle":
            webView.window?.title = try request.string("title")
            webView.window?.representedURL = try request.optionalString("path").map{URL(fileURLWithPath:$0)}
            webView.window?.isDocumentEdited = try request.boolean("edited")
            if let appearance=try request.optionalString("appearance") {guard ["light","dark"].contains(appearance) else{throw BridgeError.invalidRequest("Invalid appearance.")};webView.window?.appearance=NSAppearance(named:appearance=="dark" ? .darkAqua:.aqua)}
            return .null
        default: throw BridgeError.unsupported("Unsupported native method: \(request.method)")
        }
    }

    private func themeFiles(_ request:NativeRequest)async throws->JSONValue {
        var theme:ThemeFile?
        switch try request.optionalString("operation") ?? "list" {
        case "list": break
        case "import":
            let selected:URL?
            if let path=try request.optionalString("path") {
                guard path.hasPrefix("/"),!path.contains("\0") else{throw BridgeError.invalidRequest("Theme source must be an absolute path.")}
                selected=URL(fileURLWithPath:path)
            }
            else {selected=await chooseFile(types:[UTType(filenameExtension:"css") ?? .plainText],title:"테마 CSS 가져오기")}
            guard let selected else{return .null}
            theme=try await themes.importCSS(from:selected)
        case "write": theme=try await themes.write(name:request.string("name"),css:request.string("css"),id:request.optionalString("id"))
        case "remove": try await themes.remove(id:request.string("id"))
        case "openFolder":
            let folder=try await themes.folder()
            guard NSWorkspace.shared.open(URL(fileURLWithPath:folder,isDirectory:true)) else{throw BridgeError.unavailable("테마 폴더를 열 수 없습니다.")}
        default: throw BridgeError.unsupported("Unsupported theme file operation.")
        }
        var result:[String:JSONValue]=["themes":try await NativeReply.encode(themes.list()),"folder":.string(try await themes.folder())]
        if let theme {result["theme"]=try NativeReply.encode(theme)}
        return .object(result)
    }

    private func track(_ snapshot: DocumentSnapshot) {
        if let path = snapshot.path { documentPaths[snapshot.documentId] = path }
    }
    private func save(_ request: NativeRequest) async throws -> JSONValue {
        let id = try request.string("documentId")
        let text = try request.string("text")
        let revision = try request.integer("revision")
        let snapshot: DocumentSnapshot
        if request.method == "saveAs" || documentPaths[id] == nil || request.args["path"] != nil {
            let explicitPath = try request.optionalString("path")
            let url: URL
            if let explicitPath { url = URL(fileURLWithPath: explicitPath) }
            else {
                guard let selected = await savePanel(filename: documentPaths[id].map { URL(fileURLWithPath: $0).lastPathComponent } ?? "Untitled.md",
                                                     type: UTType(filenameExtension: "md"), window: webView.window) else { throw BridgeError.cancelled }
                url = selected
            }
            snapshot = try await documents.saveAs(id: id, path: url.path, text: text, revision: revision,
                                                  overwrite: BridgeRequestPolicy.saveAsOverwrite(explicitPath: explicitPath, force: request.boolean("force")),
                                                  assetRoot: request.optionalString("assetRoot"), imageReferences: Self.imageReferences(request))
        } else {
            snapshot = try await documents.save(id: id, text: text, revision: revision, force: request.boolean("force"),
                                                expectedDigest: request.optionalString("expectedDigest"),
                                                enforceExpectedDigest: request.args["expectedDigest"] != nil)
        }
        track(snapshot)
        return try NativeReply.encode(snapshot)
    }
    private func saveTextAsset(_ request:NativeRequest,kind:String) async throws -> JSONValue {
        let bytes=try BridgeRequestPolicy.assetBytes(kind:kind,content:request.string("content"))
        let filename=try request.optionalString("filename") ?? "Equation.\(kind)"
        guard let destination=await savePanel(filename:filename,type:UTType(filenameExtension:kind) ?? .plainText,window:webView.window) else {throw BridgeError.cancelled}
        try Task.checkCancellation();try bytes.write(to:destination,options:.atomic)
        return .object(["path":.string(destination.path),"bytes":.number(Double(bytes.count)),"diagnostics":.string("")])
    }
    private static func imageReferences(_ request: NativeRequest) throws -> [DocumentAssetReference] {
        guard let value = request.args["imageReferences"] else { return [] }
        do {
            return try JSONDecoder().decode([DocumentAssetReference].self, from: JSONSerialization.data(withJSONObject: value.foundationValue))
        } catch { throw BridgeError.invalidRequest("imageReferences must be an array of {path, from, to, html, suffix} records.") }
    }
    private func importImages(_ request: NativeRequest) async throws -> JSONValue {
        let rootPath = try request.optionalString("root")
            ?? request.optionalString("documentPath").map { URL(fileURLWithPath: $0).deletingLastPathComponent().path }
            ?? dataDirectory.appendingPathComponent("unsaved", isDirectory: true).path
        let root = URL(fileURLWithPath: rootPath, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        let directory: URL
        if let requested = try request.optionalString("directory") {
            directory = (requested.hasPrefix("/") ? URL(fileURLWithPath: requested) : root.appendingPathComponent(requested))
                .standardizedFileURL.resolvingSymlinksInPath()
        } else { directory = root.appendingPathComponent("assets", isDirectory: true).resolvingSymlinksInPath() }
        guard directory.pathComponents.starts(with: root.pathComponents), directory.pathComponents.count > root.pathComponents.count else {
            throw BridgeError.invalidRequest("Image assets directory must be inside the document root.")
        }
        if let base64 = try request.optionalString("base64") {
            guard let bytes = Data(base64Encoded: base64), NSImage(data: bytes) != nil else { throw BridgeError.invalidRequest("Invalid image data.") }
            let name = URL(fileURLWithPath: try request.optionalString("filename") ?? "image.png").lastPathComponent
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: temporary) }
            let source = temporary.appendingPathComponent(name)
            try bytes.write(to: source, options: .atomic)
            return try await NativeReply.encode(workspace.importAssets(paths: [source.path], directory: directory.path))
        }
        let panel = NSOpenPanel()
        panel.title = "Insert Images"
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        guard await run(panel, window: webView.window) == .OK else { return .array([]) }
        return try await NativeReply.encode(workspace.importAssets(paths: panel.urls.map(\.path), directory: directory.path))
    }
    private func importDocument(_ request: NativeRequest) async throws -> JSONValue {
        let path: String
        if let selected = try request.optionalString("path") { path = selected }
        else {
            guard let selected = await chooseFile(title: "Import Document") else { return .null }
            path = selected.path
        }
        if ["md", "markdown", "txt", "text"].contains(URL(fileURLWithPath: path).pathExtension.lowercased()) {
            let snapshot = try await documents.open(path: path)
            track(snapshot)
            return try NativeReply.encode(snapshot)
        }
        return try await importConvertedDocument(path: URL(fileURLWithPath: path).standardizedFileURL,
            format: request.optionalString("format"), jobId: request.optionalString("jobId") ?? UUID().uuidString)
    }
    private func importConvertedDocument(path: URL, format: String?, jobId: String) async throws -> JSONValue {
        let executable = try await exporter.pandocExecutable()
        let root = dataDirectory.appendingPathComponent("unsaved", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let folder = "import-" + UUID().uuidString
        let extraction = root.appendingPathComponent(folder, isDirectory: true)
        try FileManager.default.createDirectory(at: extraction, withIntermediateDirectories: false)
        do {
            try Task.checkCancellation()
            var arguments = ["--to=markdown", "--extract-media=\(folder)",
                "--resource-path=\(path.deletingLastPathComponent().path)", "--", path.path]
            if let format { arguments.insert("--from=\(format)", at: 0) }
            let result = try await runner.run(jobId: jobId, executable: executable, arguments: arguments, directory: root.path)
            try ExportController.check(result)
            try Task.checkCancellation()
            return try NativeReply.encode(await documents.create(text: result.stdout))
        } catch let conversionError {
            do { try FileManager.default.removeItem(at: extraction) }
            catch let cleanupError {
                throw DocumentError.io("\(conversionError.localizedDescription). Removing partial import assets at \(extraction.path) failed: \(cleanupError.localizedDescription)")
            }
            throw conversionError
        }
    }
    private func clipboard(_ request: NativeRequest) throws -> JSONValue {
        let board = pasteboard
        switch try request.string("operation") {
        case "read":
            var result: [String: JSONValue] = [:]
            if let text = board.string(forType: .string) { result["text"] = .string(text) }
            if let html = board.string(forType: .html) { result["html"] = .string(html) }
            if let bytes = board.data(forType: .png) { result["base64"] = .string(bytes.base64EncodedString()); result["type"] = .string("image/png") }
            else if let bytes = board.data(forType: .tiff) { result["base64"] = .string(bytes.base64EncodedString()); result["type"] = .string("image/tiff") }
            return .object(result)
        case "write":
            let item = NSPasteboardItem()
            var hasData = false
            if let text = try request.optionalString("text") { item.setString(text, forType: .string); hasData = true }
            if let html = try request.optionalString("html") { item.setString(html, forType: .html); hasData = true }
            if let base64 = try request.optionalString("base64") {
                guard let bytes = Data(base64Encoded: base64) else { throw BridgeError.invalidRequest("Invalid clipboard base64.") }
                let type = try request.optionalString("type") ?? "image/png"
                let pasteboardType: NSPasteboard.PasteboardType
                switch type {
                case "image/png": pasteboardType = .png
                case "image/tiff": pasteboardType = .tiff
                case "image/jpeg": pasteboardType = NSPasteboard.PasteboardType(UTType.jpeg.identifier)
                case "image/svg+xml": pasteboardType = NSPasteboard.PasteboardType("public.svg-image")
                default: throw BridgeError.unsupported("Unsupported clipboard image type: \(type)")
                }
                item.setData(bytes, forType: pasteboardType)
                hasData = true
            }
            guard hasData else { throw BridgeError.invalidRequest("Clipboard write requires text, HTML or image data.") }
            board.clearContents()
            guard board.writeObjects([item]) else { throw BridgeError.unavailable("Could not write the macOS clipboard.") }
            return .null
        default: throw BridgeError.unsupported("Unsupported clipboard operation.")
        }
    }
    private func chooseFile(types: [UTType] = [], directory: Bool = false, title: String) async -> URL? {
        let panel = NSOpenPanel()
        panel.title = title
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        if !types.isEmpty { panel.allowedContentTypes = types; panel.allowsOtherFileTypes = true }
        guard await run(panel, window: webView.window) == .OK else { return nil }
        return panel.url
    }
    private func mimeType(_ path: String) -> String {
        UTType(filenameExtension: URL(fileURLWithPath: path).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}

@MainActor
func run(_ panel: NSSavePanel, window: NSWindow?) async -> NSApplication.ModalResponse {
    let response=await withTaskCancellationHandler {
        if Task.isCancelled {return NSApplication.ModalResponse.cancel}
        return await withCheckedContinuation { continuation in
            if let window { panel.beginSheetModal(for: window) { continuation.resume(returning: $0) } }
            else { panel.begin { continuation.resume(returning: $0) } }
        }
    } onCancel: {Task { @MainActor in panel.cancel(nil) }}
    return Task.isCancelled ? .cancel:response
}

@MainActor
func savePanel(filename: String, type: UTType?, window: NSWindow?) async -> URL? {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = URL(fileURLWithPath: filename).lastPathComponent
    panel.canCreateDirectories = true
    if let type { panel.allowedContentTypes = [type] }
    guard await run(panel, window: window) == .OK else { return nil }
    return panel.url
}

 enum BridgeRequestPolicy {
    static func assetBytes(kind:String,content:String) throws -> Data {
        guard ["svg","mathml","tex"].contains(kind) else {throw BridgeError.unsupported("Unsupported selected media format: \(kind)")}
        return Data(content.utf8)
    }
    static func correlationID(_ body: Any) -> Int {
        guard let object = body as? [String:Any], let number = object["id"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, abs(number.doubleValue) <= 9_007_199_254_740_991 else { return -1 }
        return number.intValue
    }
    static func saveAsOverwrite(explicitPath: String?, force: Bool) -> Bool { explicitPath == nil || force }
}
