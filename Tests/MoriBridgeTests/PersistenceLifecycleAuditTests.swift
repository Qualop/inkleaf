import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
private final class PersistenceAuditPage: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, any Error>?
    private var timeout: Task<Void, Never>?
    func load(_ url: URL, in view: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            view.navigationDelegate = self
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                self?.finish(.failure(BridgeError.unavailable("Synthetic lifecycle page did not load")))
            }
        }
    }
    private func finish(_ result: Result<Void, any Error>) {
        let pending = continuation; continuation = nil; timeout?.cancel(); timeout = nil
        pending?.resume(with: result)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(.success(())) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
}

@MainActor
final class PersistenceLifecycleAuditTests: XCTestCase {
    private func decode(_ value: JSONValue) throws -> DocumentSnapshot {
        try JSONDecoder().decode(DocumentSnapshot.self, from: JSONEncoder().encode(value))
    }
    private func call(_ bridge: Bridge, _ method: String, _ args: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await bridge.dispatch(NativeRequest(id: 1, method: method, args: args))
    }
    private func literal(_ text: String) throws -> String { String(decoding: try JSONEncoder().encode(text), as: UTF8.self) }
    private func boolean(_ view: WKWebView, _ script: String) async throws -> Bool {
        (try await view.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) as? Bool) == true
    }

    func testActualWebKitCloseTransportPersistsDraftAndRejectsStaleApprovalBeforeRestart() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafCloseAudit-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let data = root.appendingPathComponent("state")
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", root.path, "--data-dir", data.path])
        let configuration = WKWebViewConfiguration(), handler = WeakMessageHandler()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(handler, name: "native")
        configuration.userContentController.addUserScript(WKUserScript(source: NativeCloseContract.installScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        defer { configuration.userContentController.removeScriptMessageHandler(forName: "native") }
        let owner = Bridge(webView: view, options: options, windowID: "owner", inheritLegacySession: false)
        handler.bridge = owner
        let document = try decode(await call(owner, "createDocument")), id = JSONValue.string(document.documentId)
        let first = "first draft 한글 😀\r\n", second = "second accepted draft 👩🏽‍💻\n"
        let html = """
        <!doctype html><meta charset="utf-8"><script>
        const pending=new Map();let requestId=10;
        window.__nativeReply=reply=>{const callback=pending.get(reply.id);if(!callback)return;pending.delete(reply.id);reply.ok?callback.resolve(reply.result):callback.reject(new Error(reply.error.message));};
        const native=(method,args)=>new Promise((resolve,reject)=>{const id=requestId++;pending.set(id,{resolve,reject});window.webkit.messageHandlers.native.postMessage({id,method,args});});
        window.auditText=\(try literal(first));window.auditRevision=1;window.auditCalls=0;
        window.__moriBeforeClose=async reason=>{
          window.auditCalls++;window.auditReason=reason;
          const documentId=\(try literal(document.documentId));
          await native('checkpoint',{documentId,text:window.auditText,revision:window.auditRevision});
          await native('settings',{values:{session:{documents:[{documentId,path:null}],activeDocumentId:documentId,draftRevisions:{[documentId]:window.auditRevision},views:{[documentId]:{anchor:2,head:2,scroll:120}}}}});
          return true;
        };
        </script>
        """
        let page = root.appendingPathComponent("index.html"); try html.write(to: page, atomically: true, encoding: .utf8)
        let navigation = PersistenceAuditPage(); try await navigation.load(page, in: view)
        let accepted = try await boolean(view, NativeCloseContract.quitPrepareScript)
        XCTAssertTrue(accepted)
        let initial = try await owner.documents.recoveries(); XCTAssertEqual(initial.first?.text, first)
        let persisted = try await WindowSessionStore(dataDirectory: data).all()
        XCTAssertEqual(persisted.first?.content.documents?.first?.documentId, document.documentId)
        XCTAssertEqual(persisted.first?.content.draftRevisions[document.documentId], 1)
        _ = try await view.evaluateJavaScript("window.auditText=\(try literal(second));window.auditRevision=2;window.dispatchEvent(new CompositionEvent('compositionstart'));true")
        let composing = try await boolean(view, NativeCloseContract.quitPrepareScript)
        XCTAssertFalse(composing)
        let untouched = try await owner.documents.recoveries(); XCTAssertEqual(untouched.first?.text, first)
        _ = try await view.callAsyncJavaScript("window.dispatchEvent(new CompositionEvent('compositionend'));await new Promise(resolve=>setTimeout(resolve,0));return true", arguments: [:], in: nil, contentWorld: .page)
        let nextApproval = try await boolean(view, NativeCloseContract.quitPrepareScript)
        XCTAssertTrue(nextApproval)
        let latest = try await owner.documents.recoveries(); XCTAssertEqual(latest.first?.text, second)
        _ = try await view.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mori-document-change'));true")
        do {
            try await owner.removeWindowSession(keepSession: true, validate: { (try? await self.boolean(view, NativeCloseContract.quitValidationScript)) ?? false })
            XCTFail("Canonical edits must invalidate an earlier quit approval")
        } catch { XCTAssertEqual((error as? BridgeError)?.code, "cancelled") }
        let contender = DocumentStore(dataDirectory: data)
        do { _ = try await contender.restore(id: document.documentId); XCTFail("Cancelled close released the owner") }
        catch { XCTAssertEqual(error as? DocumentError, .conflict(document.documentId)) }
        let finalApproval = try await boolean(view, NativeCloseContract.quitPrepareScript)
        XCTAssertTrue(finalApproval)
        try await owner.removeWindowSession(keepSession: true, validate: { (try? await self.boolean(view, NativeCloseContract.quitValidationScript)) ?? false })
        let sessionsAfterQuit = try await WindowSessionStore(dataDirectory: data).all()
        XCTAssertEqual(sessionsAfterQuit.first?.content.draftRevisions[document.documentId], 2)
        let restartConfiguration = WKWebViewConfiguration(); restartConfiguration.websiteDataStore = .nonPersistent()
        let restarted = Bridge(webView: WKWebView(frame: .zero, configuration: restartConfiguration), options: options, windowID: "owner", inheritLegacySession: false)
        let restored = try decode(await call(restarted, "restoreDocument", ["documentId": id, "path": .null]))
        XCTAssertEqual(restored.text, second); XCTAssertEqual(restored.revision, 2); XCTAssertNil(restored.path)
        let views = sessionsAfterQuit.first?.content.views[document.documentId]
        XCTAssertEqual(views, .object(["anchor": .number(2), "head": .number(2), "scroll": .number(120)]))
        _ = try await call(restarted, "closeDocument", ["documentId": id, "discardRecovery": .bool(true)])
        try await restarted.removeWindowSession()
        let empty = try await WindowSessionStore(dataDirectory: data).all(), recoveries = try await restarted.documents.recoveries()
        XCTAssertTrue(empty.isEmpty); XCTAssertTrue(recoveries.isEmpty)
        print("PERSISTENCE_CLOSE actual WKWebView message transport, synthetic composition guard, revalidation, persisted restart and explicit discard passed; no OS quit gesture tested")
    }
}
