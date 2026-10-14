import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

final class BridgeServiceTests: XCTestCase {
    @MainActor
    private func bridge(at root: URL) throws -> Bridge {
        _ = NSApplication.shared
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", root.path, "--data-dir", root.appendingPathComponent("data").path])
        return Bridge(webView: WKWebView(), options: options)
    }
    private func fixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-bridge-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func request(_ method: String, _ args: [String: Any] = [:]) throws -> NativeRequest {
        try NativeRequest.parse(["id": 1, "method": method, "args": args])
    }
    private func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard case .object(let object) = value else { throw BridgeError.invalidRequest("Expected test result object") }
        return object
    }
    private func string(_ value: JSONValue?) throws -> String {
        guard case .string(let string) = value else { throw BridgeError.invalidRequest("Expected test result string") }
        return string
    }

    @MainActor
    func testBlankDocumentSaveReopenAndConflictThroughParser() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root)
        let created = try object(await bridge.dispatch(request("createDocument")))
        XCTAssertEqual(created["text"], .string(""))
        XCTAssertEqual(created["path"], .null)
        let id = try string(created["documentId"])
        let path = root.appendingPathComponent("한글 fixture.md").path
        let text = "# 한글 😀\r\n\r\nlast line"
        let saved = try object(await bridge.dispatch(request("saveAs", ["documentId": id, "path": path, "text": text, "revision": 3])))
        XCTAssertEqual(saved["revision"], .number(3))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data(text.utf8))
        let reopened = try object(await bridge.dispatch(request("openDocument", ["path": path])))
        XCTAssertEqual(reopened["text"], .string(text))
        let external = "externally changed"
        try Data(external.utf8).write(to: URL(fileURLWithPath: path))
        do {
            _ = try await bridge.dispatch(request("saveDocument", ["documentId": id, "text": "ours", "revision": 4]))
            XCTFail("Expected external modification conflict")
        } catch let error as DocumentError { XCTAssertEqual(error, .conflict(path)) }
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), external)
    }

    @MainActor
    func testBootstrapRestoresCheckpointAndPersistsSettingsInInjectedDirectory() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try bridge(at: root)
        let initial = try object(await first.dispatch(request("bootstrap")))
        XCTAssertEqual(initial["recoveries"], .array([]))
        let document = try object(await first.dispatch(request("createDocument")))
        let id = try string(document["documentId"])
        _ = try await first.dispatch(request("checkpoint", ["documentId": id, "text": "recovery 한글", "revision": 2]))
        _ = try await first.dispatch(request("settings", ["values": ["appearance": "dark", "zoom": 1.25]]))
        _ = try await first.dispatch(request("closeDocument", ["documentId": id]))
        let second = try bridge(at: root)
        let result = try object(await second.dispatch(request("bootstrap")))
        XCTAssertEqual(try object(XCTUnwrap(result["settings"]))["appearance"], .string("dark"))
        guard case .array(let recoveries) = result["recoveries"] else { return XCTFail("Missing recovery array") }
        XCTAssertEqual(recoveries.count, 1)
        XCTAssertEqual(try object(XCTUnwrap(recoveries.first))["text"], .string("recovery 한글"))
        _ = try await second.dispatch(request("restoreDocument", ["documentId": id]))
        _ = try await second.dispatch(request("saveAs", ["documentId": id, "path": root.appendingPathComponent("restored.md").path,
                                                         "text": "recovery 한글", "revision": 2]))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("restored.md")), Data("recovery 한글".utf8))
    }

    @MainActor
    func testWorkspaceAssetsAndRealToolUnicodeArguments() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root)
        let file = root.appendingPathComponent("asset.svg")
        let bytes = Data("<svg>한글</svg>".utf8)
        try bytes.write(to: file)
        let result = try object(await bridge.dispatch(request("readAsset", ["path": "asset.svg", "root": root.path])))
        XCTAssertEqual(result["base64"], .string(bytes.base64EncodedString()))
        do {
            _ = try await bridge.dispatch(request("readAsset", ["path": "../outside", "root": root.path]))
            XCTFail("Expected asset containment error")
        } catch let error as DocumentError { guard case .invalidPath = error else { return XCTFail("Wrong error: \(error)") } }
        let tool = try object(await bridge.dispatch(request("runTool", ["jobId": "fixture", "executable": "/usr/bin/printf", "arguments": ["%s", "한글 'spaces' 😀"]])))
        XCTAssertEqual(tool["stdout"], .string("한글 'spaces' 😀"))
        XCTAssertEqual(tool["exitCode"], .number(0))
        XCTAssertEqual(tool["cancelled"], .bool(false))
        do { _ = try await bridge.dispatch(request("performSelector", ["selector": "terminate:"])); XCTFail("Unknown methods must fail") }
        catch let error as BridgeError { XCTAssertEqual(error.code, "unsupported") }
    }
}
