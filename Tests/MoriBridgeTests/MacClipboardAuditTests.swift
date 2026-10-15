import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class MacClipboardAuditTests: XCTestCase {
    func testSystemClipboardTransportPreservesTextHTMLImagesAndRejectsInvalidWrites() async throws {
        _ = NSApplication.shared
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafClipboardAudit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let options = try LaunchOptions(arguments: ["audit", "--web-root", root.path, "--data-dir", root.appendingPathComponent("data").path])
        let bridge = Bridge(webView: WKWebView(), options: options, pasteboard: board)
        func call(_ args: [String: JSONValue]) async throws -> JSONValue {
            let result = try await bridge.dispatch(NativeRequest(id: 1, method: "clipboard", args: args))
            return result
        }
        let text = "# 한글 😀\r\n\r\nclipboard", html = "<p>한글 <strong>😀 clipboard</strong></p>"
        _ = try await call(["operation": .string("write"), "text": .string(text), "html": .string(html)])
        guard case .object(let rich) = try await call(["operation": .string("read")]) else { return XCTFail("Missing rich clipboard response") }
        XCTAssertEqual(rich["text"], .string(text)); XCTAssertEqual(rich["html"], .string(html))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2,
            pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32))
        let color = NSColor(deviceRed: 0.2, green: 0.6, blue: 0.3, alpha: 1)
        for y in 0..<2 { for x in 0..<2 { bitmap.setColor(color, atX: x, y: y) } }
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let tiff = try XCTUnwrap(bitmap.representation(using: .tiff, properties: [:]))
        for (type, bytes) in [("image/png", png), ("image/tiff", tiff)] {
            _ = try await call(["operation": .string("write"), "type": .string(type), "base64": .string(bytes.base64EncodedString())])
            guard case .object(let image) = try await call(["operation": .string("read")]) else { return XCTFail("Missing image clipboard response") }
            XCTAssertEqual(image["type"], .string(type)); XCTAssertEqual(image["base64"], .string(bytes.base64EncodedString()))
        }
        let changeBeforeFailure = board.changeCount
        do {
            _ = try await call(["operation": .string("write"), "base64": .string("invalid-base64!")])
            XCTFail("Invalid clipboard image must fail")
        } catch { XCTAssertEqual((error as? BridgeError)?.code, "invalidRequest") }
        XCTAssertEqual(board.changeCount, changeBeforeFailure)
        print("MAC_CLIPBOARD_AUDIT private named pasteboard: text/html/png/tiff exact transport; invalid write retained data; general clipboard never accessed")
    }
}
