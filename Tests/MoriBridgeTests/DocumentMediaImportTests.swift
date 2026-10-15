import AppKit
import WebKit
import XCTest
import DocumentCore
import ToolCore
@testable import Mori

@MainActor final class DocumentMediaImportTests: XCTestCase {
    private var pandoc: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tools/pandoc")
    }
    private func fixture() throws -> URL {
        _ = NSApplication.shared
        let base = ProcessInfo.processInfo.environment["MORI_MEDIA_IMPORT_ARTIFACTS"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent("MediaImport-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if ProcessInfo.processInfo.environment["MORI_MEDIA_IMPORT_ARTIFACTS"] == nil {
            addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        }
        return root
    }
    private func bridge(_ root: URL, converter: URL? = nil) async throws -> Bridge {
        let options = try LaunchOptions(arguments: ["Inkleaf", "--web-root", root.path, "--data-dir", root.appendingPathComponent("profile").path])
        let bridge = Bridge(webView: WKWebView(), options: options)
        _ = try await bridge.settings.update(values: ["pandocPath": .string((converter ?? pandoc).path)])
        return bridge
    }
    private func call(_ bridge: Bridge, _ method: String, _ args: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await bridge.dispatch(NativeRequest(id: 1, method: method, args: args))
    }
    private func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard case .object(let value) = value else { throw BridgeError.invalidRequest("Expected object") }
        return value
    }
    private func string(_ value: JSONValue?) throws -> String {
        guard case .string(let value) = value else { throw BridgeError.invalidRequest("Expected string") }
        return value
    }
    private func image() throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 9, pixelsHigh: 7,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        for y in 0..<7 { for x in 0..<9 { bitmap.setColor(NSColor(deviceRed: 0.2, green: 0.8, blue: 0.1, alpha: 1), atX: x, y: y) } }
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }
    private func imageReference(_ text: String) throws -> (url: String, range: NSRange) {
        let expression = try NSRegularExpression(pattern: "!\\[[^\\]]*\\]\\(([^)]+)\\)")
        let range = try XCTUnwrap(expression.firstMatch(in: text, range: NSRange(location: 0, length: text.utf16.count))).range(at: 1)
        return ((text as NSString).substring(with: range), range)
    }
    private func exportedDocument(_ root: URL, format: String, bytes: Data) async throws -> URL {
        try bytes.write(to: root.appendingPathComponent("embedded.png"))
        let settings = SettingsStore(dataDirectory: root.appendingPathComponent("export-profile"))
        _ = try await settings.update(values: ["pandocPath": .string(pandoc.path)])
        let exporter = ExportController(runner: ProcessRunner(), settings: settings), target = root.appendingPathComponent("source." + format)
        _ = try await exporter.export(NativeRequest(id: 1, method: "export", args: [
            "format": .string(format), "content": .string("# 한글 import\n\n![pixel](embedded.png)\n\nUNCHANGED_TAIL"),
            "documentPath": .string(root.appendingPathComponent("source.md").path),
            "options": .object(["destination": .string(target.path)])]), window: nil)
        return target
    }
    private func roundTrip(_ format: String, recover: Bool) async throws {
        let root = try fixture(), png = try image(), input = try await exportedDocument(root, format: format, bytes: png)
        let original = try Data(contentsOf: input)
        let first = try await bridge(root), bootstrap = try object(await call(first, "bootstrap"))
        let assetRoot = URL(fileURLWithPath: try string(bootstrap["unsavedAssetRoot"]), isDirectory: true)
        let imported = try object(await call(first, "importDocument", ["path": .string(input.path)]))
        let text = try string(imported["text"]), id = try string(imported["documentId"]), reference = try imageReference(text)
        XCTAssertEqual(imported["path"], .null); XCTAssertTrue(text.contains("UNCHANGED_TAIL"))
        XCTAssertTrue(reference.url.hasPrefix("import-"), "Imported URLs must be relative to the global unsaved root: \(reference.url)")
        let asset = assetRoot.appendingPathComponent(reference.url.removingPercentEncoding ?? reference.url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: asset.path), "The imported image must actually be extracted")
        guard FileManager.default.fileExists(atPath: asset.path) else { return }
        XCTAssertEqual(try Data(contentsOf: asset), png)
        let preview = try object(await call(first, "readAsset", ["path": .string(asset.path), "root": .string(assetRoot.path)]))
        XCTAssertEqual(Data(base64Encoded: try string(preview["base64"])), png)
        var active = first
        if recover {
            _ = try await call(first, "checkpoint", ["documentId": .string(id), "text": .string(text), "revision": .number(1)])
            await first.documents.closeAll()
            active = try await bridge(root)
            let restored = try object(await call(active, "restoreDocument", ["documentId": .string(id)]))
            XCTAssertEqual(restored["text"], .string(text))
            let freshBootstrap = try object(await call(active, "bootstrap"))
            XCTAssertEqual(freshBootstrap["unsavedAssetRoot"], bootstrap["unsavedAssetRoot"])
            let read = try object(await call(active, "readAsset", ["path": .string(asset.path), "root": .string(assetRoot.path)]))
            XCTAssertEqual(Data(base64Encoded: try string(read["base64"])), png)
        }
        let destination = root.appendingPathComponent("published/note.md")
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let saved = try object(await call(active, "saveAs", ["documentId": .string(id), "path": .string(destination.path),
            "text": .string(text), "revision": .number(2), "assetRoot": .string(assetRoot.path),
            "imageReferences": .array([.object(["path": .string(asset.path), "from": .number(Double(reference.range.location)),
                "to": .number(Double(NSMaxRange(reference.range))), "html": .bool(false), "suffix": .string("")])])]))
        let savedText = try string(saved["text"]), published = try imageReference(savedText)
        XCTAssertTrue(published.url.hasPrefix("assets/"))
        XCTAssertEqual(try Data(contentsOf: destination.deletingLastPathComponent().appendingPathComponent(published.url.removingPercentEncoding ?? published.url)), png)
        let reopened = try object(await call(active, "openDocument", ["path": .string(destination.path)]))
        XCTAssertEqual(reopened["text"], saved["text"]); XCTAssertTrue(savedText.contains("UNCHANGED_TAIL"))
        XCTAssertEqual(try Data(contentsOf: input), original)
        XCTAssertEqual(try Data(contentsOf: asset), png, "Successful import assets must survive first-save publication")
        print("DOCUMENT_MEDIA_IMPORT \(format) \(root.path)")
    }
    func testDOCXEmbeddedBytesSurviveImportPreviewRecoveryPublicationAndReopen() async throws {
        try await roundTrip("docx", recover: true)
    }
    func testEPUBEmbeddedBytesSurviveImportPreviewPublicationAndReopen() async throws {
        try await roundTrip("epub", recover: false)
    }
    func testRepeatedImportsHaveIndependentMediaDirectories() async throws {
        let root = try fixture(), png = try image(), source = try await exportedDocument(root, format: "docx", bytes: png), bridge = try await bridge(root)
        let a = try object(await call(bridge, "importDocument", ["path": .string(source.path)]))
        let b = try object(await call(bridge, "importDocument", ["path": .string(source.path)]))
        let first = try imageReference(string(a["text"])), second = try imageReference(string(b["text"]))
        XCTAssertNotEqual(first.url, second.url, "Repeated imports must never share an extraction destination")
        for item in [first, second] {
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("profile/unsaved/" + item.url)), png)
        }
    }
    func testHTMLRelativeResourcesResolveBesideSourceWhileMediaExtractsUnderUnsavedRoot() async throws {
        let root = try fixture(), sourceFolder = root.appendingPathComponent("source # 한글%")
        try FileManager.default.createDirectory(at: sourceFolder, withIntermediateDirectories: true)
        let png = try image(); try png.write(to: sourceFolder.appendingPathComponent("pixel.png"))
        let source = sourceFolder.appendingPathComponent("note.html")
        try Data("<h1>한글</h1><img src=\"pixel.png\" alt=\"pixel\"><p>HTML_TAIL</p>".utf8).write(to: source)
        let bridge = try await bridge(root)
        let imported = try object(await call(bridge, "importDocument", ["path": .string(source.path)]))
        let text = try string(imported["text"]), reference = try imageReference(text)
        XCTAssertTrue(reference.url.hasPrefix("import-")); XCTAssertTrue(text.contains("HTML_TAIL"))
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("profile/unsaved/" + reference.url)), png)
        XCTAssertEqual(try Data(contentsOf: sourceFolder.appendingPathComponent("pixel.png")), png)
    }
    func testPlainTextImportsKeepOriginalBindingAndDoNotRequirePandocOrCreateExtractionFolders() async throws {
        let root = try fixture(), bridge = try await bridge(root, converter: root.appendingPathComponent("missing-pandoc"))
        for ext in ["md", "txt"] {
            let source = root.appendingPathComponent("source." + ext), text = "한글\r\nUNCHANGED\r\n"
            try Data(text.utf8).write(to: source)
            let imported = try object(await call(bridge, "importDocument", ["path": .string(source.path)]))
            XCTAssertEqual(imported["path"], .string(source.path)); XCTAssertEqual(imported["text"], .string(text))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("profile/unsaved").path))
    }
    private func fakeConverter(_ root: URL, exits: Bool) throws -> (tool: URL, marker: URL) {
        let tool = root.appendingPathComponent("fake-pandoc"), marker = root.appendingPathComponent("converter-observation")
        let quotedMarker = "'" + marker.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let script = """
        #!/bin/sh
        audit_media=''
        for audit_argument in "$@"; do
          case "$audit_argument" in --extract-media=*) audit_media=${audit_argument#*=} ;; esac
        done
        mkdir -p "${audit_media:-legacy-output}/media"
        printf partial > "${audit_media:-legacy-output}/media/partial.png"
        printf '%s\\n%s\\n' "$PWD" "$audit_media" > \(quotedMarker)
        \(exits ? "printf CONVERSION_FAILED >&2; exit 9" : "sleep 5; printf success")
        """
        try Data(script.utf8).write(to: tool)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
        return (tool, marker)
    }
    private func existingAssets(_ root: URL) throws -> URL {
        let assets = root.appendingPathComponent("profile/unsaved")
        try FileManager.default.createDirectory(at: assets.appendingPathComponent("prior-import/media"), withIntermediateDirectories: true)
        try Data("KEEP".utf8).write(to: assets.appendingPathComponent("prior-import/media/keep.png"))
        return assets
    }
    private func verifyRollback(_ assets: URL, marker: URL) throws {
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: assets.path), ["prior-import"])
        XCTAssertEqual(try Data(contentsOf: assets.appendingPathComponent("prior-import/media/keep.png")), Data("KEEP".utf8))
        let observation = try String(contentsOf: marker, encoding: .utf8).components(separatedBy: "\n")
        XCTAssertEqual(URL(fileURLWithPath: observation[0]).resolvingSymlinksInPath().path, assets.resolvingSymlinksInPath().path)
        XCTAssertTrue(observation[1].hasPrefix("import-")); XCTAssertFalse(observation[1].hasPrefix("/"))
    }
    func testFailedConversionRemovesOnlyItsExtractionDirectory() async throws {
        let root = try fixture(), assets = try existingAssets(root), fake = try fakeConverter(root, exits: true), bridge = try await bridge(root, converter: fake.tool)
        do { _ = try await call(bridge, "importDocument", ["path": .string(root.appendingPathComponent("input.docx").path)]); XCTFail("Expected converter failure") }
        catch BridgeError.toolFailed(let message) { XCTAssertTrue(message.contains("CONVERSION_FAILED")) }
        try verifyRollback(assets, marker: fake.marker)
    }
    func testNativeCancelAndTaskCancellationRemoveOnlyTheirExtractionDirectories() async throws {
        for cancelTask in [false, true] {
            let root = try fixture(), assets = try existingAssets(root), fake = try fakeConverter(root, exits: false), bridge = try await bridge(root, converter: fake.tool)
            let task = Task { try await self.call(bridge, "importDocument", ["path": .string(root.appendingPathComponent("input.docx").path), "jobId": .string("media-import-cancel")]) }
            for _ in 0..<200 where !FileManager.default.fileExists(atPath: fake.marker.path) { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: fake.marker.path))
            if cancelTask { task.cancel() }
            else {
                let result = try object(await call(bridge, "cancelTool", ["jobId": .string("media-import-cancel")]))
                XCTAssertEqual(result["cancelled"], .bool(true))
            }
            do { _ = try await task.value; XCTFail("Expected cancelled conversion") } catch { }
            try verifyRollback(assets, marker: fake.marker)
            let recoveries = try await bridge.documents.recoveries()
            XCTAssertTrue(recoveries.isEmpty)
        }
    }
}
