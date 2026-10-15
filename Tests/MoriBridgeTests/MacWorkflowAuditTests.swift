import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class MacWorkflowAuditTests: XCTestCase {
    func testRealWebKitApplicationNativeFilesSettingsSpellingAndRestart() async throws {
        guard let web = ProcessInfo.processInfo.environment["INKLEAF_MAC_AUDIT_WEB_ROOT"] else {
            throw XCTSkip("Run node scripts/verify-mac-app.mjs for the isolated full-app WebKit audit")
        }
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafMacAudit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let document = root.appendingPathComponent("문서 #100%.md"), initial = "초기 원문 😀\n"
        try Data(initial.utf8).write(to: document)
        let options = try LaunchOptions(arguments: ["audit", "--web-root", web, "--data-dir", root.appendingPathComponent("profile").path])
        let settings = SettingsStore(dataDirectory: options.dataDirectory)
        _ = try await settings.update(values: ["language": .string("en"), "spellLanguage": .string("auto")])
        let sessions = WindowSessionStore(dataDirectory: options.dataDirectory)
        func makeView(initialSession: WindowSessionContent? = nil) -> (WKWebView, NSWindow, Bridge) {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let handler = WeakMessageHandler()
            configuration.userContentController.add(handler, name: "native")
            let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760), configuration: configuration)
            let bridge = Bridge(webView: view, options: options, windowSessions: sessions, settingsStore: settings,
                                windowID: "full-app-audit", initialSession: initialSession)
            handler.bridge = bridge
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = view
            window.orderFront(nil)
            view.loadFileURL(URL(fileURLWithPath: web).appendingPathComponent("index.html"), allowingReadAccessTo: URL(fileURLWithPath: "/"))
            return (view, window, bridge)
        }
        func ready(_ view: WKWebView) async throws {
            for _ in 0..<500 {
                if (try? await view.evaluateJavaScript("typeof window.macAuditReady !== 'undefined'")) as? Bool == true { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            XCTFail("Audit page never loaded"); throw BridgeError.unavailable("Audit page never loaded")
        }
        let (view, window, bridge) = makeView()
        defer { window.close() }
        try await ready(view)
        let raw = try await view.callAsyncJavaScript("return await window.macAudit.run(options);", arguments: ["options": ["documentPath": document.path, "initialText": initial]], in: nil, contentWorld: .page)
        let json = try XCTUnwrap(raw as? String), data = try XCTUnwrap(json.data(using: .utf8))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let failures = try XCTUnwrap(result["failures"] as? [[String: Any]])
        print("MAC_APP_AUDIT " + json)
        XCTAssertTrue(failures.isEmpty, "Full application failures: \(failures)")
        let stored = try await settings.all()
        guard case .string(let saved) = stored["auditSavedText"] else { return XCTFail("No acknowledged save bytes") }
        XCTAssertEqual(try Data(contentsOf: document), Data(saved.utf8), "Native save writes the exact frontend source bytes")
        let records = try await sessions.all(), savedSession = try XCTUnwrap(records.first { $0.id == "full-app-audit" })
        try await bridge.removeWindowSession(keepSession: true)
        window.close()
        let (restoredView, restoredWindow, restoredBridge) = makeView(initialSession: savedSession.content)
        defer { restoredWindow.close() }
        try await ready(restoredView)
        let restoredRaw = try await restoredView.callAsyncJavaScript("return await window.macAudit.restored();", arguments: [:], in: nil, contentWorld: .page)
        let restoredJSON = try XCTUnwrap(restoredRaw as? String)
        let restored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(restoredJSON.utf8)) as? [String: Any])
        let before = try XCTUnwrap(result["documents"] as? [[String: Any]])
        let after = try XCTUnwrap(restored["documents"] as? [[String: Any]])
        XCTAssertEqual(before.map { $0["text"] as? String }, after.map { $0["text"] as? String }, "Quit/restart restores all draft source, in order")
        XCTAssertEqual(before.map { $0["id"] as? String }, after.map { $0["id"] as? String }, "Draft identities survive restart")
        XCTAssertEqual(before.map { $0["path"] as? String }, after.map { $0["path"] as? String }, "Paths remain paired with the same draft identities")
        XCTAssertEqual(result["activeId"] as? String, restored["activeId"] as? String)
        try await restoredBridge.removeWindowSession(keepSession: true)
        if failures.isEmpty,
           before.map({ $0["text"] as? String }) == after.map({ $0["text"] as? String }),
           before.map({ $0["id"] as? String }) == after.map({ $0["id"] as? String }),
           before.map({ $0["path"] as? String }) == after.map({ $0["path"] as? String }),
           result["activeId"] as? String == restored["activeId"] as? String,
           try Data(contentsOf: document) == Data(saved.utf8) {
            print("MAC_APP_AUDIT restart-and-file-bytes verified")
        }
    }
}
