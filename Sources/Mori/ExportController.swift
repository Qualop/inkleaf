import AppKit
import WebKit
import UniformTypeIdentifiers
import DocumentCore
import ToolCore
import PDFKit

@MainActor
final class ExportController {
    private let runner: ProcessRunner
    private let settings: SettingsStore
    private var pages: [String: ExportPage] = [:]
    private var jobs=ExportJobs()

    init(runner: ProcessRunner, settings: SettingsStore) { self.runner = runner; self.settings = settings }

    @discardableResult func cancel(jobId: String)->Bool{let accepted=jobs.cancel(jobId);if accepted{pages[jobId]?.cancel()};return accepted}
    func committedPath(jobId:String)->String?{jobs.outputPath(jobId)}

    func pandocExecutable() async throws -> String {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("tools/pandoc").path
        if let bundled, FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        let values = try await settings.all()
        if case .string(let path) = values["pandocPath"], !path.isEmpty {
            guard FileManager.default.isExecutableFile(atPath: path) else { throw BridgeError.unavailable("Configured Pandoc is not executable: \(path)") }
            return path
        }
        let directories = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
            + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        for directory in directories where directory.hasPrefix("/") {
            let path = URL(fileURLWithPath: directory).appendingPathComponent("pandoc").path
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        throw BridgeError.unavailable("Pandoc was not found. Install free Pandoc or set pandocPath to its executable.")
    }

    static func check(_ result: ToolResult) throws {
        if result.cancelled { throw BridgeError.cancelled }
        if result.timedOut { throw BridgeError.toolFailed("Tool timed out. \(result.stderr)") }
        if result.outputTruncated { throw BridgeError.toolFailed("Tool output exceeded the limit. \(result.stderr)") }
        guard result.exitCode == 0 else { throw BridgeError.toolFailed("Tool exited with status \(result.exitCode). \(result.stderr)") }
    }

    func export(_ request: NativeRequest, window: NSWindow?) async throws -> JSONValue {
        let format = try request.string("format").lowercased()
        let content = try request.string("content")
        let options = try request.object("options")
        let filename = try request.optionalString("filename") ?? "Untitled.\(format == "jpeg" ? "jpg" : format)"
        let jobId = try request.optionalString("jobId") ?? UUID().uuidString
        let postExecutable=try Self.string(options,"postCommand")
        let postArgs:[String]?
        if let value=options["postArguments"]{guard case .array(let list)=value else{throw BridgeError.invalidRequest("Post-command arguments must be an array.")};postArgs=try list.map{guard case .string(let string)=$0 else{throw BridgeError.invalidRequest("Post-command arguments must be strings.")};return string}}
        else{postArgs=nil}
        try jobs.begin(jobId);defer{jobs.finish(jobId)}
        let destination:URL
        if case .string(let previous)=options["destination"],previous.hasPrefix("/"){
            let target=URL(fileURLWithPath:previous).standardizedFileURL
            if FileManager.default.fileExists(atPath:target.path){
                let alert=NSAlert();alert.messageText="Replace the previous exported file?";alert.informativeText=target.path;alert.addButton(withTitle:"Replace");alert.addButton(withTitle:"Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else{throw BridgeError.cancelled}
            };destination=target
        }else if let selected=await savePanel(filename: filename, type: UTType(filenameExtension: format), window: window){destination=selected}
        else{
            throw BridgeError.cancelled
        }
        try jobs.check(jobId)
        let documentPath = try request.optionalString("documentPath")
        let bytes: Data
        var diagnostics = ""
        switch format {
        case "html", "htm", "txt", "text", "tex", "md", "markdown":
            bytes = Data(content.utf8)
        case "svg":
            if content.trimmingCharacters(in:.whitespacesAndNewlines).hasPrefix("<svg"){
                bytes=Data(content.utf8)
            }else{
                let page=try ExportPage(options:options)
                pages[jobId]=page;defer{pages.removeValue(forKey:jobId);page.close()}
                try await page.load(html:content,documentPath:documentPath);try jobs.check(jobId)
                let xhtml=try await page.webView.evaluateJavaScript("new XMLSerializer().serializeToString(document.documentElement)")
                guard let document=xhtml as? String else{throw BridgeError.unavailable("Could not serialize the SVG document.")}
                let width=page.webView.frame.width,height=page.webView.frame.height
                bytes=Data("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(width)\" height=\"\(height)\" viewBox=\"0 0 \(width) \(height)\"><foreignObject width=\"100%\" height=\"100%\">\(document)</foreignObject></svg>".utf8)
            }
        case "pdf", "png", "jpeg", "jpg":
            let page = try ExportPage(options: options,paginated:format=="pdf")
            guard pages[jobId] == nil else { throw BridgeError.invalidRequest("Export job is already running.") }
            pages[jobId] = page
            defer { pages.removeValue(forKey: jobId); page.close() }
            try await page.load(html: content, documentPath: documentPath)
            try jobs.check(jobId)
            if format == "pdf" {
                bytes=try await page.pdf(options:options){try self.jobs.check(jobId)}
            } else {
                let config = WKSnapshotConfiguration()
                config.rect = page.webView.bounds
                config.snapshotWidth = NSNumber(value: page.width)
                let image = try await page.webView.takeSnapshot(configuration: config)
                guard let tiff = image.tiffRepresentation, let representation = NSBitmapImageRep(data: tiff),
                      let encoded = representation.representation(using: format == "png" ? .png : .jpeg,
                          properties: [.compressionFactor: try Self.number(options, "quality", default: 0.9, range: 0...1)]) else {
                    throw BridgeError.unavailable("WebKit could not encode the exported image.")
                }
                bytes = encoded
            }
        default:
            guard let writer=ExportGeometry.writer(format) else { throw BridgeError.unsupported("Unsupported export format: \(format)") }
            let executable = try await pandocExecutable()
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-export-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: temporary) }
            let output = temporary.appendingPathComponent("output.\(format)")
            let from = try Self.string(options, "from") ?? "markdown"
            var arguments = ["--from=\(from)", "--to=\(writer)", "--output=\(output.path)"]
            if try Self.boolean(options, "standalone", default: true) { arguments.append("--standalone") }
            if try Self.boolean(options, "toc", default: false) { arguments.append("--toc") }
            for key in ["template", "referenceDoc", "css"] {
                if let value = try Self.string(options, key) {
                    let flag = key == "referenceDoc" ? "reference-doc" : key
                    arguments.append("--\(flag)=\(value)")
                }
            }
            for key in ["title", "author"] {
                if let value = try Self.string(options, key) { arguments.append("--metadata=\(key):\(value)") }
            }
            if let depth=options["tocDepth"]{
                guard case .number(let value)=depth,value>=1,value<=6,value.rounded()==value else{throw BridgeError.invalidRequest("Contents depth must be between 1 and 6.")}
                arguments.append("--toc-depth=\(Int(value))")
            }
            for key in ["extraArguments","extraArgs"]{
                if let value=options[key]{guard case .array(let values)=value else{throw BridgeError.invalidRequest("Extra arguments must be a JSON array.")}
                    for item in values{guard case .string(let argument)=item else{throw BridgeError.invalidRequest("Every extra argument must be a string.")};arguments.append(argument)}
                }
            }
            let directory = documentPath.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path }
            let result = try await runner.run(jobId: jobId, executable: executable, arguments: arguments,
                                             input: content, directory: directory, timeout: 120)
            try Self.check(result)
            guard FileManager.default.fileExists(atPath: output.path) else { throw BridgeError.toolFailed("Pandoc produced no output file. \(result.stderr)") }
            bytes = try Data(contentsOf: output)
            diagnostics = result.stderr
        }
        try Task.checkCancellation()
        try jobs.check(jobId)
        try bytes.write(to: destination, options: .atomic)
        jobs.commit(jobId,path:destination.path)
        if let executable=postExecutable,!executable.isEmpty{
            let args=postArgs?.map{$0.replacingOccurrences(of:"${output}",with:destination.path)} ?? [destination.path]
            do{
                let post=try await runner.run(jobId:jobId,executable:executable,arguments:args,directory:destination.deletingLastPathComponent().path,timeout:60)
                diagnostics+=post.stderr+post.stdout
                if post.outputTruncated{diagnostics+="\nPost-export command output was truncated at the output limit."}
                if post.cancelled || post.timedOut || post.exitCode != 0{diagnostics+="\nThe output file was created, but the post-export command did not complete successfully."}
            }catch{diagnostics+="\nThe output file was created, but the post-export command failed: \(error.localizedDescription)"}
        }
        return .object(["path": .string(destination.path), "bytes": .number(Double(bytes.count)),
                        "jobId": .string(jobId), "diagnostics": .string(diagnostics)])
    }

    func printHTML(_ request: NativeRequest, window: NSWindow?) async throws -> JSONValue {
        let page = try ExportPage(options: request.object("options"),paginated:true)
        defer { page.close() }
        try await page.load(html: request.string("content"), documentPath: request.optionalString("documentPath"))
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        let data=try await page.pdf(options:request.object("options")){}
        guard let document=PDFDocument(data:data),let operation=document.printOperation(for:info,scalingMode:.pageScaleNone,autoRotate:false) else{throw BridgeError.unavailable("Could not prepare PDF printing.")}
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        guard operation.run() else { throw BridgeError.cancelled }
        return .null
    }

    static func number(_ options: [String: JSONValue], _ key: String, default fallback: Double, range: ClosedRange<Double>) throws -> Double {
        guard let value = options[key] else { return fallback }
        guard case .number(let number) = value, range.contains(number) else { throw BridgeError.invalidRequest("Export option '\(key)' is outside its allowed range.") }
        return number
    }
    private static func string(_ options: [String: JSONValue], _ key: String) throws -> String? {
        guard let value = options[key], value != .null else { return nil }
        guard case .string(let string) = value else { throw BridgeError.invalidRequest("Export option '\(key)' must be a string.") }
        return string
    }
    private static func boolean(_ options: [String: JSONValue], _ key: String, default fallback: Bool) throws -> Bool {
        guard let value = options[key] else { return fallback }
        guard case .bool(let boolean) = value else { throw BridgeError.invalidRequest("Export option '\(key)' must be boolean.") }
        return boolean
    }
}

/// A dedicated, non-scriptable page holds one immutable HTML export snapshot.
@MainActor
private final class ExportPage: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let width: Double
    private let window: NSWindow
    private let requestedHeight: Double?
    private var continuation: CheckedContinuation<Void, any Error>?
    private var cancelled = false
    private var timeout: Task<Void, Never>?
    private var assetRoot: URL?
    private let paginated:Bool

    init(options: [String: JSONValue],paginated:Bool=false) throws {
        self.paginated=paginated
        if paginated{let geometry=try ExportGeometry(options:options);width=max(1,(geometry.width-2*geometry.margin).rounded())}
        else{width = try ExportController.number(options, "width", default: 1024, range: 100...8192)}
        if options["height"] != nil {
            requestedHeight = try ExportController.number(options, "height", default: 768, range: 100...32768)
        } else { requestedHeight = nil }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: requestedHeight ?? 768), configuration: configuration)
        window = NSWindow(contentRect: webView.frame, styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.contentView = webView
        webView.navigationDelegate = self
    }
    func load(html: String, documentPath: String?) async throws {
        assetRoot = documentPath.map { URL(fileURLWithPath: $0).deletingLastPathComponent().resolvingSymlinksInPath() }
        window.orderBack(nil)
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.loadHTMLString(html, baseURL: assetRoot)
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                self?.finish(.failure(BridgeError.unavailable("Export page did not finish loading within 30 seconds.")))
            }
        }
        guard !cancelled else { throw BridgeError.cancelled }
        let heightValue = try await webView.evaluateJavaScript("Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight)")
        let contentHeight = (heightValue as? NSNumber)?.doubleValue ?? 768
        if paginated{return}
        guard requestedHeight != nil || contentHeight <= 32768 else { throw BridgeError.invalidRequest("The complete document is too tall for one image. Export PDF or reduce image width/text size.") }
        let height = requestedHeight ?? max(100, contentHeight)
        guard width * height <= 67_108_864 else { throw BridgeError.invalidRequest("Export image dimensions exceed the pixel limit. Reduce width or height.") }
        webView.setFrameSize(NSSize(width: width, height: height))
        window.setContentSize(webView.frame.size)
    }
    func pdf(options:[String:JSONValue],check:()throws->Void)async throws->Data{
        let geometry=try ExportGeometry(options:options)
        let pageHeight=geometry.height-2*geometry.margin
        let metrics=try await pdfMetrics(),data=NSMutableData(),composer=try PagedPDF(data:data,geometry:geometry)
        _ = try PagedPDF.slices(height:metrics.height,pageHeight:pageHeight,breaks:[])
        let config=WKPDFConfiguration();config.rect=CGRect(x:0,y:0,width:width,height:metrics.height)
        let captured=try await webView.pdf(configuration:config),actual=try PagedPDF.textMetrics(captured)
        // DOM positions are CSS coordinates; normalize through the actual capture's MediaBox to paper points.
        let contentWidth=geometry.width-2*geometry.margin
        let scale=actual.height/metrics.height*contentWidth/actual.width
        let protected=(metrics.lines+metrics.objects).map{($0.lowerBound*scale)..<($0.upperBound*scale)}
        let forced=options["splitPages"] == .bool(true) ? metrics.headings.map{$0*scale}:[]
        for slice in try PagedPDF.slices(height:metrics.height*scale,pageHeight:pageHeight,breaks:metrics.breaks.map{$0*scale},forced:forced,protected:protected){
            try check();try Task.checkCancellation()
            let height=slice.upperBound-slice.lowerBound,part=WKPDFConfiguration();part.rect=CGRect(x:0,y:slice.lowerBound/scale,width:width,height:height/scale)
            let content=try await webView.pdf(configuration:part);try check();try composer.append(content,height:height)
        };composer.finish();return data as Data
    }
    func pdfMetrics()async throws->(height:Double,breaks:[Double],lines:[Range<Double>],objects:[Range<Double>],headings:[Double]){
        let script="""
        (()=>{document.body.style.padding='0';document.body.style.margin='0';document.body.style.maxWidth='none';
        const lines=[],objects=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
        while(node=walker.nextNode()){if(!node.textContent.trim() || /^(STYLE|SCRIPT)$/.test(node.parentElement?.tagName||''))continue;const range=document.createRange();range.selectNodeContents(node);for(const rect of range.getClientRects())if(rect.height>0)lines.push([rect.top+scrollY,rect.bottom+scrollY]);}
        for(const el of document.querySelectorAll('img,svg,tr,pre,h1,h2,h3,h4,h5,h6')){const r=el.getBoundingClientRect();if(r.height>0)objects.push([r.top+scrollY,r.bottom+scrollY]);}
        const breaks=[];let height=Math.max(1,document.body.scrollHeight);
        for(const r of [...lines,...objects]){breaks.push(r[0],r[1]);height=Math.max(height,r[1]);}
        const headings=Array.from(document.querySelectorAll('article h1')).slice(1).map(el=>el.getBoundingClientRect().top+scrollY);
        return {height,breaks,lines,objects,headings};})()
        """
        guard let value=try await webView.evaluateJavaScript(script) as? [String:Any],let height=value["height"] as? NSNumber else{throw BridgeError.unavailable("Could not measure PDF content.")}
        func ranges(_ key:String)->[Range<Double>]{
            (value[key] as? [[NSNumber]] ?? []).compactMap{pair in
                guard pair.count==2 else{return nil}
                let top=pair[0].doubleValue,bottom=pair[1].doubleValue
                guard top.isFinite,bottom.isFinite,bottom>top else{return nil}
                return top..<bottom
            }
        }
        return (height.doubleValue,(value["breaks"] as? [NSNumber] ?? []).map(\.doubleValue),ranges("lines"),ranges("objects"),(value["headings"] as? [NSNumber] ?? []).map(\.doubleValue))
    }
    func close() { timeout?.cancel(); webView.stopLoading(); window.close() }
    func cancel() { cancelled = true; webView.stopLoading(); finish(.failure(BridgeError.cancelled)) }
    private func finish(_ result: Result<Void, any Error>) {
        timeout?.cancel()
        let current = continuation
        continuation = nil
        current?.resume(with: result)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if url?.absoluteString == "about:blank" { decisionHandler(.allow) }
        else if let url, url.isFileURL, let assetRoot,
                url.resolvingSymlinksInPath().pathComponents.starts(with: assetRoot.pathComponents) { decisionHandler(.allow) }
        else { decisionHandler(.cancel) }
    }
}
