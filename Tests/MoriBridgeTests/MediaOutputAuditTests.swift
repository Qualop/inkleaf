import AppKit
import WebKit
import PDFKit
import XCTest
import DocumentCore
import ToolCore
@testable import Mori

@MainActor final class MediaOutputAuditTests: XCTestCase {
    private func root(_ name: String) throws -> URL {
        let base = ProcessInfo.processInfo.environment["MORI_MEDIA_AUDIT_ARTIFACTS"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent(name + "-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if ProcessInfo.processInfo.environment["MORI_MEDIA_AUDIT_ARTIFACTS"] == nil {
            addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        }
        return root
    }
    private func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard case .object(let values) = value else { throw BridgeError.invalidRequest("Expected object") }
        return values
    }
    private func exporter(_ root: URL) async throws -> ExportController {
        let settings = SettingsStore(dataDirectory: root.appendingPathComponent("profile"))
        let pandoc = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tools/pandoc")
        _ = try await settings.update(values: ["pandocPath": .string(pandoc.path)])
        return ExportController(runner: ProcessRunner(), settings: settings)
    }
    private func export(_ exporter: ExportController, _ format: String, _ content: String, _ target: URL,
                        options: [String: JSONValue] = [:], document: URL? = nil) async throws -> [String: JSONValue] {
        var values = options; values["destination"] = .string(target.path)
        return try object(await exporter.export(NativeRequest(id: 1, method: "export", args: [
            "format": .string(format), "content": .string(content), "options": .object(values),
            "jobId": .string(UUID().uuidString), "documentPath": document.map { .string($0.path) } ?? .null
        ]), window: nil))
    }

    func testConfiguredPandocWinsOverBundledConverterAndInvalidOverrideFails() async throws {
        let root = try root("converter-selection"), resources = root.appendingPathComponent("Resources")
        try FileManager.default.createDirectory(at: resources.appendingPathComponent("tools"), withIntermediateDirectories: true)
        let bundled = resources.appendingPathComponent("tools/pandoc"), configured = root.appendingPathComponent("custom-pandoc")
        for file in [bundled, configured] {
            try Data("#!/bin/sh\nexit 0\n".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        let settings = SettingsStore(dataDirectory: root.appendingPathComponent("profile"))
        let exporter = ExportController(runner: ProcessRunner(), settings: settings)
        _ = try await settings.update(values: ["pandocPath": .string(configured.path)])
        let selected = try await exporter.pandocExecutable(resourceDirectory: resources)
        XCTAssertEqual(selected, configured.path, "The Settings converter override must work in packaged builds too")
        _ = try await settings.update(values: ["pandocPath": .string(root.appendingPathComponent("missing").path)])
        do { _ = try await exporter.pandocExecutable(resourceDirectory: resources); XCTFail("Invalid explicit override must be reported") } catch { }
        _ = try await settings.update(values: ["pandocPath": .string("")])
        let fallback = try await exporter.pandocExecutable(resourceDirectory: resources)
        XCTAssertEqual(fallback, bundled.path)
    }

    func testActualTextAndPandocOutputsRoundTripUnicodeAndMetadata() async throws {
        let root = try root("formats"), exporter = try await exporter(root)
        let source = "# 한글 😀 Audit\r\n\r\n**Strong** and tail MEDIA_AUDIT_END.\r\n\r\n| Name | Value |\r\n| --- | --- |\r\n| row | 42 |\r\n"
        for (format, content) in [("md", source), ("txt", "한글 😀\r\nplain tail"), ("html", "<!doctype html><p>한글 😀</p>"),
                                  ("svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"30\"><rect width=\"40\" height=\"30\" fill=\"red\"/></svg>")] {
            let target = root.appendingPathComponent("output." + format)
            let reply = try await export(exporter, format, content, target)
            XCTAssertEqual(try Data(contentsOf: target), Data(content.utf8))
            XCTAssertEqual(reply["bytes"], .number(Double(content.utf8.count)))
        }
        let options = try LaunchOptions(arguments: ["Inkleaf", "--web-root", root.path, "--data-dir", root.appendingPathComponent("import-profile").path])
        _ = NSApplication.shared
        let bridge = Bridge(webView: WKWebView(), options: options)
        _ = try await bridge.settings.update(values: ["pandocPath": .string(URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tools/pandoc").path)])
        for format in ["docx", "epub"] {
            let target = root.appendingPathComponent("output." + format)
            _ = try await export(exporter, format, source, target, options: ["title": .string("한글 Audit"), "author": .string("Local auditor"), "toc": .bool(true)])
            XCTAssertEqual(try Data(contentsOf: target).prefix(2), Data("PK".utf8))
            let imported = try object(await bridge.dispatch(NativeRequest(id: 2, method: "importDocument", args: ["path": .string(target.path)])))
            guard case .string(let text) = imported["text"] else { return XCTFail("Missing imported source") }
            XCTAssertTrue(text.contains("한글")); XCTAssertTrue(text.contains("MEDIA_AUDIT_END")); XCTAssertTrue(text.contains("42"))
            try Data(text.utf8).write(to: root.appendingPathComponent("roundtrip-" + format + ".md"))
        }
        for format in ["html", "txt"] {
            let imported = try object(await bridge.dispatch(NativeRequest(id: 3, method: "importDocument", args: ["path": .string(root.appendingPathComponent("output." + format).path)])))
            guard case .string(let text) = imported["text"] else { return XCTFail("Missing text import") }
            XCTAssertTrue(text.contains("한글")); XCTAssertTrue(text.contains("😀"))
        }
        print("MEDIA_AUDIT_FORMATS " + root.path)
    }

    func testImageImportCollisionAndFirstSavePublishesRealImageBytes() async throws {
        _ = NSApplication.shared
        let root = try root("images"), bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 12, pixelsHigh: 9,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        for y in 0..<9 { for x in 0..<12 { bitmap.setColor(NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1), atX: x, y: y) } }
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let options = try LaunchOptions(arguments: ["Inkleaf", "--web-root", root.path, "--data-dir", root.appendingPathComponent("profile").path])
        let bridge = Bridge(webView: WKWebView(), options: options)
        var paths: [String] = []
        for _ in 0..<2 {
            let result = try await bridge.dispatch(NativeRequest(id: 1, method: "importImages", args: ["base64": .string(png.base64EncodedString()), "filename": .string("한글 #1%.png"), "directory": .string("assets")]))
            guard case .array(let entries) = result, case .string(let path) = entries.first else { return XCTFail("Missing image path") }
            paths.append(path); XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), png)
        }
        XCTAssertNotEqual(paths[0], paths[1])
        let assetRoot = options.dataDirectory.appendingPathComponent("unsaved")
        let relative = "assets/" + URL(fileURLWithPath: paths[0]).lastPathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "#%")))!
        let source = "😀 ![image](" + relative + ")\r\nTAIL"
        let doc = await bridge.documents.create(text: source), range = (source as NSString).range(of: relative)
        let target = root.appendingPathComponent("published/note.md")
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        let saved = try await bridge.documents.saveAs(id: doc.documentId, path: target.path, text: source, revision: 1,
            assetRoot: assetRoot.path, imageReferences: [DocumentAssetReference(path: paths[0], from: range.location, to: NSMaxRange(range))])
        XCTAssertEqual(saved.text, source); XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), source)
        XCTAssertEqual(try Data(contentsOf: target.deletingLastPathComponent().appendingPathComponent("assets/" + URL(fileURLWithPath: paths[0]).lastPathComponent)), png)
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.deletingLastPathComponent().appendingPathComponent("assets/" + URL(fileURLWithPath: paths[1]).lastPathComponent).path))
        print("MEDIA_AUDIT_IMAGES " + root.path)
    }

    func testRealRasterAndPaginatedPDFPreserveTailAndHaveVisiblePaint() async throws {
        _ = NSApplication.shared
        let root = try root("rendered"), exporter = try await exporter(root)
        let html = "<!doctype html><html><head><style>body{margin:0;background:white;color:black;font:16px Helvetica}p{margin:0;line-height:24px}.color{width:120px;height:80px;background:rgb(230,10,20)}</style></head><body><article><p>한글 MEDIA_START</p><div class='color'></div>" + (1...100).map { "<p>ROW_\($0)</p>" }.joined() + "<p>MEDIA_LAST_END</p></article></body></html>"
        for format in ["png", "jpeg"] {
            let target = root.appendingPathComponent("output." + format)
            _ = try await export(exporter, format, html, target, options: ["width": .number(600), "quality": .number(0.8)])
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: Data(contentsOf: target)))
            XCTAssertGreaterThanOrEqual(bitmap.pixelsWide, 600); XCTAssertGreaterThan(bitmap.pixelsHigh, 2400)
            XCTAssertGreaterThan(try Data(contentsOf: target).count, 1000)
        }
        let svgTarget = root.appendingPathComponent("document.svg")
        _ = try await export(exporter, "svg", html, svgTarget, options: ["width": .number(600)])
        let svg = try String(contentsOf: svgTarget, encoding: .utf8)
        XCTAssertTrue(svg.hasPrefix("<svg")); XCTAssertTrue(svg.contains("<foreignObject")); XCTAssertTrue(svg.contains("MEDIA_LAST_END"))
        XCTAssertTrue(svg.contains("http://www.w3.org/1999/xhtml"))
        let target = root.appendingPathComponent("output.pdf")
        _ = try await export(exporter, "pdf", html, target, options: ["paper": .string("a4"), "margin": .number(20)])
        let data = try Data(contentsOf: target), pdf = try XCTUnwrap(PDFDocument(data: data))
        XCTAssertGreaterThan(pdf.pageCount, 2); XCTAssertEqual(visiblePDFTextPages(pdf, token: "MEDIA_LAST_END"), [pdf.pageCount - 1])
        for page in 0..<pdf.pageCount {
            let image = try PDFTestRaster(data: data, page: page)
            XCTAssertNotNil(image.bounds { r, g, b in r < 200 || g < 200 || b < 200 })
        }
        print("MEDIA_AUDIT_RENDERED " + root.path)
    }

    func testPostCommandFailureKeepsOutputAndMissingPandocDoesNotPublish() async throws {
        let root = try root("failures"), exporter = try await exporter(root), output = root.appendingPathComponent("kept.txt")
        let reply = try await export(exporter, "txt", "IMMUTABLE OUTPUT", output, options: ["postCommand": .string("/bin/sh"), "postArguments": .array([.string("-c"), .string("printf 'POST_FAIL' >&2; exit 7")])])
        XCTAssertEqual(try String(contentsOf: output, encoding: .utf8), "IMMUTABLE OUTPUT")
        guard case .string(let diagnostic) = reply["diagnostics"] else { return XCTFail("Missing diagnostic") }
        XCTAssertTrue(diagnostic.contains("POST_FAIL")); XCTAssertTrue(diagnostic.contains("output file was created"))
        let settings = SettingsStore(dataDirectory: root.appendingPathComponent("missing-profile"))
        _ = try await settings.update(values: ["pandocPath": .string(root.appendingPathComponent("does-not-exist").path)])
        let failing = ExportController(runner: ProcessRunner(), settings: settings), target = root.appendingPathComponent("missing.docx")
        do { _ = try await export(failing, "docx", "must not publish", target); XCTFail("Expected missing converter") } catch { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let broken = root.appendingPathComponent("bad-pandoc")
        try Data("#!/bin/sh\nprintf CONVERTER_FAILED >&2\nexit 9\n".utf8).write(to: broken)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: broken.path)
        _ = try await settings.update(values: ["pandocPath": .string(broken.path)])
        do { _ = try await export(failing, "docx", "must not publish", target); XCTFail("Expected converter failure") }
        catch BridgeError.toolFailed(let message) { XCTAssertTrue(message.contains("CONVERTER_FAILED")); XCTAssertTrue(message.contains("9")) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        print("MEDIA_AUDIT_FAILURES " + root.path)
    }

    func testPandocCancellationDoesNotPublishAndPostCommandReceivesActualOutputPath() async throws {
        _ = NSApplication.shared
        let root = try root("cancellation"), marker = root.appendingPathComponent("started"), tool = root.appendingPathComponent("slow-pandoc")
        try Data("#!/bin/sh\nprintf started > '\(marker.path)'\nsleep 1\n".utf8).write(to: tool)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tool.path)
        let options = try LaunchOptions(arguments: ["Inkleaf", "--web-root", root.path, "--data-dir", root.appendingPathComponent("profile").path])
        let bridge = Bridge(webView: WKWebView(), options: options), target = root.appendingPathComponent("cancelled.docx")
        _ = try await bridge.settings.update(values: ["pandocPath": .string(tool.path)])
        let task = Task { try await bridge.dispatch(NativeRequest(id: 1, method: "export", args: [
            "format": .string("docx"), "content": .string("KEEP SOURCE"), "jobId": .string("audit-cancel"),
            "options": .object(["destination": .string(target.path)])])) }
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: marker.path) { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path))
        let cancelled = try object(await bridge.dispatch(NativeRequest(id: 2, method: "cancelTool", args: ["jobId": .string("audit-cancel")])))
        XCTAssertEqual(cancelled["cancelled"], .bool(true))
        do { _ = try await task.value; XCTFail("Cancelled conversion must fail") } catch { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        let exporter = try await exporter(root), output = root.appendingPathComponent("literal path 한글.txt")
        let result = try await export(exporter, "txt", "KEEP SOURCE", output, options: [
            "postCommand": .string("/usr/bin/printf"), "postArguments": .array([.string("%s|%s"), .string("${output}"), .string("literal $() ;")])])
        XCTAssertEqual(result["diagnostics"], .string(output.path + "|literal $() ;"))
        XCTAssertEqual(try String(contentsOf: output, encoding: .utf8), "KEEP SOURCE")
        print("MEDIA_AUDIT_CANCEL " + root.path)
    }

    func testEmbeddedImageDOCXImportRecordsExtractedMediaEvidence() async throws {
        _ = NSApplication.shared
        let root = try root("embedded-import"), exporter = try await exporter(root)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        for y in 0..<8 { for x in 0..<8 { bitmap.setColor(NSColor(deviceRed: 0, green: 0.8, blue: 0, alpha: 1), atX: x, y: y) } }
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: root.appendingPathComponent("embedded.png"))
        let source = "# Imported picture\n\n![embedded](embedded.png)\n\nIMPORT_IMAGE_TAIL", target = root.appendingPathComponent("picture.docx")
        _ = try await export(exporter, "docx", source, target, document: root.appendingPathComponent("source.md"))
        let options = try LaunchOptions(arguments: ["Inkleaf", "--web-root", root.path, "--data-dir", root.appendingPathComponent("profile-import").path])
        let bridge = Bridge(webView: WKWebView(), options: options)
        _ = try await bridge.settings.update(values: ["pandocPath": .string(URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tools/pandoc").path)])
        let imported = try await bridge.dispatch(NativeRequest(id: 1, method: "importDocument", args: ["path": .string(target.path)]))
        let values = try object(imported)
        guard case .string(let text) = values["text"] else { return XCTFail("Missing imported text") }
        XCTAssertTrue(text.contains("IMPORT_IMAGE_TAIL")); XCTAssertTrue(text.contains("embedded"))
        let bytes = try JSONSerialization.data(withJSONObject: imported.foundationValue, options: [.prettyPrinted, .sortedKeys])
        try bytes.write(to: root.appendingPathComponent("imported-snapshot.json"))
        try Data(text.utf8).write(to: root.appendingPathComponent("imported.md"))
        print("MEDIA_AUDIT_EMBEDDED_IMPORT " + root.path)
    }
}
