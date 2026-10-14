import AppKit
import WebKit
import DocumentCore

@MainActor
final class MoriWindowController: NSWindowController, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate {
    let webView: WKWebView
    let bridge: Bridge
    private let webRoot: URL
    private let hasEditorPage: Bool
    private var ready = false
    private var queuedPaths: [String] = []
    private var closing=false
    private var allowClose=false
    var onClose: (() -> Void)?

    init(options: LaunchOptions,windowSessions:WindowSessionStore?=nil,settings:SettingsStore?=nil,restored:WindowSession?=nil,inheritLegacySession:Bool=true) {
        webRoot = options.webRoot.resolvingSymlinksInPath()
        let index = options.webRoot.appendingPathComponent("index.html")
        hasEditorPage = FileManager.default.fileExists(atPath: index.path)
        let configuration = WKWebViewConfiguration()
        let handler = WeakMessageHandler()
        configuration.userContentController.add(handler, name: "native")
        configuration.userContentController.addUserScript(WKUserScript(source:NativeCloseContract.installScript,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760), configuration: configuration)
        bridge = Bridge(webView:webView,options:options,windowSessions:windowSessions,settingsStore:settings,windowID:restored?.id ?? UUID().uuidString,initialSession:restored?.content,inheritLegacySession:inheritLegacySession)
        handler.bridge = bridge
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Untitled — Inkleaf"
        window.minSize = NSSize(width: 620, height: 420)
        window.contentView = webView
        window.isReleasedWhenClosed = false
        window.center()
        if let frame=restored?.frame,frame.isValid{
            var rect=NSRect(x:frame.x,y:frame.y,width:frame.width,height:frame.height)
            if let screen=NSScreen.screens.first(where:{$0.visibleFrame.intersects(rect)}) ?? NSScreen.main{
                let bounds=screen.visibleFrame;rect.size.width=min(rect.width,bounds.width);rect.size.height=min(rect.height,bounds.height)
                rect.origin.x=max(bounds.minX,min(rect.minX,bounds.maxX-rect.width));rect.origin.y=max(bounds.minY,min(rect.minY,bounds.maxY-rect.height))
            };window.setFrame(rect,display:false)
        }
        super.init(window: window)
        window.delegate = self
        webView.uiDelegate = self
        webView.navigationDelegate = self
        bridge.onReady = { [weak self] in
            guard let self else { return }
            ready = true
            for path in queuedPaths { bridge.command(NativeCommand(type: "openDocument", value: .string(path))) }
            queuedPaths.removeAll()
        }
        if hasEditorPage {
            webView.loadFileURL(index, allowingReadAccessTo: options.webRoot)
        } else {
            let alert = NSAlert()
            alert.messageText = "Inkleaf editor resources are missing"
            alert.informativeText = "Expected \(index.path). Build the web assets or launch with --web-root PATH."
            alert.beginSheetModal(for: window)
        }
    }
    required init?(coder: NSCoder) { fatalError("Use init(options:)") }
    func enqueueOpen(_ path: String) {
        if ready { bridge.command(NativeCommand(type: "openDocument", value: .string(path))) }
        else { queuedPaths.append(path) }
    }
    func windowWillClose(_ notification: Notification) { onClose?() }
    func windowDidMove(_ notification:Notification){persistGeometry()}
    func windowDidResize(_ notification:Notification){persistGeometry()}
    func windowDidBecomeKey(_ notification:Notification){Task{@MainActor [weak self] in try? await self?.bridge.focusWindow()}}
    private func persistGeometry(){Task{@MainActor [weak self] in guard let self else{return};do{try await bridge.persistWindowFrame()}catch{bridge.command(NativeCommand(type:"host-error",value:.string(error.localizedDescription)))}}}
    func prepareToClose(reason:String="window") async -> Bool {
        guard hasEditorPage else { return true }
        do {
            let result=try await webView.callAsyncJavaScript(reason=="quit" ? NativeCloseContract.quitPrepareScript:NativeCloseContract.prepareScript,arguments:[:],in:nil,contentWorld:.page)
            return (result as? Bool)==true
        }catch{
            let alert=NSAlert();alert.messageText="The document could not be checkpointed.";alert.informativeText="Keep this window open and save your document before closing. \(error.localizedDescription)";alert.runModal();return false
        }
    }
    func closeApprovalIsCurrent(reason:String="window") async -> Bool {
        guard hasEditorPage else {return true}
        do {
            let result=try await webView.callAsyncJavaScript(reason=="quit" ? NativeCloseContract.quitValidationScript:NativeCloseContract.windowValidationScript,arguments:[:],in:nil,contentWorld:.page)
            return (result as? Bool)==true
        } catch {return false}
    }
    func windowShouldClose(_ sender:NSWindow)->Bool{
        if allowClose{return true};if closing{return false};closing=true
        Task{@MainActor [weak self] in
            guard let self else{return}
            defer {closing=false}
            let reason="window"
            if await prepareToClose(reason:reason) {
                do {
                    try await bridge.removeWindowSession(keepSession:reason=="quit",validate:{[weak self] in await self?.closeApprovalIsCurrent(reason:reason) ?? false})
                    allowClose=true;sender.performClose(nil)
                } catch BridgeError.cancelled {} catch {let alert=NSAlert(error:error);await alert.beginSheetModal(for:sender)}
            }
        };return false
    }
    func printDocument() { bridge.command(NativeCommand(type: "print")) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL && url.resolvingSymlinksInPath().pathComponents.starts(with: webRoot.pathComponents) {
            decisionHandler(.allow)
        } else { decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert(); alert.messageText = message
        if let window { alert.beginSheetModal(for: window) { _ in completionHandler() } }
        else { alert.runModal(); completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        if let window { alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) } }
        else { completionHandler(alert.runModal() == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        if let window { alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) } }
        else { completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
}
