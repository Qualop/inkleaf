import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class AppIconBridgeTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-icons-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func bridge(at root: URL, data: URL? = nil, icons: AppIconController? = nil) throws -> Bridge {
        _ = NSApplication.shared
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", root.path, "--data-dir", (data ?? root).path])
        return Bridge(webView: WKWebView(), options: options, appIconController: icons)
    }

    private func write(_ bridge: Bridge, values: [String: JSONValue], operation: String = "write") async throws -> JSONValue {
        try await bridge.dispatch(NativeRequest(id: 1, method: "settings", args: ["operation": .string(operation), "values": .object(values)]))
    }

    private func preferences(_ bridge: Bridge, method: String = "settings", operation: String? = nil) async throws -> [String: JSONValue] {
        var args: [String: JSONValue] = [:]
        if let operation { args["operation"] = .string(operation) }
        let result = try await bridge.dispatch(NativeRequest(id: 1, method: method, args: args))
        guard case .object(let object) = result else { throw BridgeError.invalidRequest("Expected object") }
        if method == "bootstrap", case .object(let settings) = object["settings"] { return settings }
        return object
    }

    func testInvalidIconRejectsEveryWriteAliasBeforeAnyDiskMutation() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let invalid: [JSONValue] = [.string("concept1"), .string("INK"), .string(""), .null, .bool(true), .number(1), .array([]), .object([:])]
        for operation in ["write", "update", "set", "reset"] {
            for (index, icon) in invalid.enumerated() {
                let data = root.appendingPathComponent("\(operation)-\(index)")
                let bridge = try bridge(at: root, data: data)
                do {
                    _ = try await write(bridge, values: ["appIcon": icon, "fontSize": .number(22), "session": WindowSessionContent.empty.json], operation: operation)
                    XCTFail("Accepted invalid appIcon: \(icon) via \(operation)")
                } catch {
                    XCTAssertEqual((error as? BridgeError)?.code, "invalidRequest")
                }
                XCTAssertFalse(FileManager.default.fileExists(atPath: data.path), "Invalid settings must not persist the session or preferences")
            }
        }
    }

    func testCorruptedStoredIconDefaultsToInkForBootstrapAndReads() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        for stored in [JSONValue.string("broken"), .null, .number(5)] {
            _ = try await SettingsStore(dataDirectory: root).update(values: ["appIcon": stored, "fontSize": .number(19)])
            let bridge = try bridge(at: root)
            for (method, operation) in [("bootstrap", nil), ("settings", "read"), ("settings", "get")] {
                let prefs = try await preferences(bridge, method: method, operation: operation)
                XCTAssertEqual(prefs["appIcon"], .string("ink"))
                XCTAssertEqual(prefs["fontSize"], .number(19))
            }
        }
    }

    func testResetPersistsInkEvenWhenAnOldClientSuppliesLeaf() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root)
        _ = try await write(bridge, values: ["appIcon": .string("leaf")])
        _ = try await write(bridge, values: ["appIcon": .string("leaf")], operation: "reset")
        let persisted = try await SettingsStore(dataDirectory: root).all()
        XCTAssertEqual(persisted["appIcon"], .string("ink"))
        let relaunched = try await preferences(self.bridge(at: root), method: "bootstrap")
        XCTAssertEqual(relaunched["appIcon"], .string("ink"))
    }

    func testTwoWindowsPreserveGlobalIconAcrossStaleWritesAndRelaunch() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let a = try bridge(at: root), b = try bridge(at: root)
        for bridge in [a, b] {
            let initial = try await preferences(bridge, method: "bootstrap")
            XCTAssertEqual(initial["appIcon"], .string("ink"))
        }
        _ = try await write(a, values: ["appIcon": .string("leaf")])
        _ = try await write(b, values: ["appIcon": .string("ink"), "fontSize": .number(21)])
        let latest = try await preferences(b)
        XCTAssertEqual(latest["appIcon"], .string("leaf"))
        let relaunched = try await preferences(self.bridge(at: root), method: "bootstrap")
        XCTAssertEqual(relaunched["appIcon"], .string("leaf"))
        _ = try await write(b, values: [:], operation: "reset")
        _ = try await write(a, values: ["appIcon": .string("leaf"), "fontSize": .number(22)])
        let persisted = try await SettingsStore(dataDirectory: root).all()
        XCTAssertEqual(persisted["appIcon"], .string("ink"))
    }

    func testAuthoritativeReadRefreshesOnlyIconBaselineForAnExplicitSelection() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        for operation in ["read", "get"] {
            let data = root.appendingPathComponent(operation)
            let a = try bridge(at: root, data: data), b = try bridge(at: root, data: data)
            for bridge in [a, b] {
                _ = try await write(bridge, values: ["appIcon": .string("ink"), "fontSize": .number(18)])
                _ = try await preferences(bridge, method: "bootstrap")
            }
            _ = try await write(a, values: ["appIcon": .string("leaf"), "fontSize": .number(22)])
            let refreshed = try await preferences(b, operation: operation)
            XCTAssertEqual(refreshed["appIcon"], .string("leaf"))
            _ = try await write(b, values: ["appIcon": .string("ink"), "fontSize": .number(18)])
            let persisted = try await SettingsStore(dataDirectory: data).all()
            XCTAssertEqual(persisted["appIcon"], .string("ink"), "An explicit selection after refreshing must replace the current icon")
            XCTAssertEqual(persisted["fontSize"], .number(22), "Refreshing icons must preserve the other stale-setting baselines")
        }
    }

    func testSettingsReadDoesNotCreateAClientBaselineBeforeBootstrap() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        for operation in ["read", "get"] {
            let data = root.appendingPathComponent(operation)
            let a = try bridge(at: root, data: data), b = try bridge(at: root, data: data)
            _ = try await write(a, values: ["appIcon": .string("ink")])
            _ = try await preferences(b, operation: operation)
            _ = try await write(a, values: ["appIcon": .string("leaf")])
            _ = try await write(b, values: ["appIcon": .string("ink")])
            let persisted = try await SettingsStore(dataDirectory: data).all()
            XCTAssertEqual(persisted["appIcon"], .string("ink"), "Read alone must not enable stale-write filtering before bootstrap")
        }
    }

    private func iconResources(at root: URL) throws -> AppIconController {
        for (name, color) in [("ink", NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1)),
                              ("leaf", NSColor(deviceRed: 0, green: 1, blue: 0, alpha: 1))] {
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 32,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0))
            for y in 0..<32 { for x in 0..<32 { bitmap.setColor(color, atX: x, y: y) } }
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            func length(_ value: Int) -> Data {
                Data([UInt8((value >> 24) & 255), UInt8((value >> 16) & 255), UInt8((value >> 8) & 255), UInt8(value & 255)])
            }
            let icns = Data("icns".utf8) + length(png.count + 16) + Data("icp5".utf8) + length(png.count + 8) + png
            let url = root.appendingPathComponent("AppIcon-\(name).icns")
            try icns.write(to: url)
            XCTAssertNotNil(NSImage(contentsOf: url), "The fixture must be a readable ICNS file")
        }
        return AppIconController(resourceDirectory: root)
    }

    private func iconRaster(_ image: NSImage) throws -> Data {
        let tiff = try XCTUnwrap(image.tiffRepresentation)
        let source = try XCTUnwrap(NSBitmapImageRep(data: tiff)?.cgImage)
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8,
            bytesPerRow: 128, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
        context.interpolationQuality = .none
        context.setBlendMode(.copy)
        context.draw(source, in: CGRect(x: 0, y: 0, width: 32, height: 32))
        return Data(bytes: try XCTUnwrap(context.data), count: 32 * 32 * 4)
    }

    private func assertApplicationIcon(leaf: Bool, resourcesAt root: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let selected = try XCTUnwrap(NSImage(contentsOf: root.appendingPathComponent("AppIcon-\(leaf ? "leaf" : "ink").icns")), file: file, line: line)
        let other = try XCTUnwrap(NSImage(contentsOf: root.appendingPathComponent("AppIcon-\(leaf ? "ink" : "leaf").icns")), file: file, line: line)
        let actual = try XCTUnwrap(NSApplication.shared.applicationIconImage, file: file, line: line)
        let expected = try iconRaster(selected)
        XCTAssertNotEqual(expected, try iconRaster(other), "The two fixture icons must remain distinguishable", file: file, line: line)
        XCTAssertEqual(try iconRaster(actual), expected, "The application icon must match the selected ICNS resource", file: file, line: line)
    }

    func testNativeIconAppliesPersistedSelectionAtStartupAndAfterAcceptedWrites() async throws {
        _ = NSApplication.shared
        let previous = NSApplication.shared.applicationIconImage
        defer { NSApplication.shared.applicationIconImage = previous }
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let icons = try iconResources(at: root)
        icons.apply(settings: [:])
        try assertApplicationIcon(leaf: false, resourcesAt: root)
        let settings = SettingsStore(dataDirectory: root)
        _ = try await settings.update(values: ["appIcon": .string("leaf")])
        icons.apply(settings: try await SettingsStore(dataDirectory: root).all())
        try assertApplicationIcon(leaf: true, resourcesAt: root)

        let a = try bridge(at: root, icons: icons), b = try bridge(at: root, icons: icons)
        NSApplication.shared.applicationIconImage = previous
        _ = try await preferences(a, method: "bootstrap")
        try assertApplicationIcon(leaf: true, resourcesAt: root)
        _ = try await preferences(b, method: "bootstrap")
        _ = try await write(a, values: ["appIcon": .string("ink")])
        try assertApplicationIcon(leaf: false, resourcesAt: root)
        _ = try await write(b, values: ["appIcon": .string("leaf"), "fontSize": .number(24)])
        try assertApplicationIcon(leaf: false, resourcesAt: root)
        _ = try await write(a, values: ["appIcon": .string("leaf")])
        try assertApplicationIcon(leaf: true, resourcesAt: root)
        _ = try await write(b, values: [:], operation: "reset")
        try assertApplicationIcon(leaf: false, resourcesAt: root)
        _ = try await write(a, values: ["appIcon": .string("leaf"), "fontSize": .number(25)])
        try assertApplicationIcon(leaf: false, resourcesAt: root)

        _ = try await settings.update(values: ["appIcon": .string("corrupt")])
        NSApplication.shared.applicationIconImage = previous
        icons.apply(settings: try await SettingsStore(dataDirectory: root).all())
        try assertApplicationIcon(leaf: false, resourcesAt: root)
    }

    func testFailedSettingsPersistenceDoesNotChangeNativeIcon() async throws {
        _ = NSApplication.shared
        let previous = NSApplication.shared.applicationIconImage
        defer { NSApplication.shared.applicationIconImage = previous }
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let icons = try iconResources(at: root)
        let bridge = try bridge(at: root, icons: icons)
        _ = try await write(bridge, values: ["appIcon": .string("leaf")])
        try assertApplicationIcon(leaf: true, resourcesAt: root)
        let file = root.appendingPathComponent("settings.json")
        let accepted = try Data(contentsOf: file)
        do {
            _ = try await write(bridge, values: ["appIcon": .null, "fontSize": .number(27), "session": WindowSessionContent.empty.json])
            XCTFail("Expected invalid request")
        } catch { XCTAssertEqual((error as? BridgeError)?.code, "invalidRequest") }
        XCTAssertEqual(try Data(contentsOf: file), accepted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("window-sessions.json").path))
        try assertApplicationIcon(leaf: true, resourcesAt: root)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        do {
            _ = try await write(bridge, values: ["appIcon": .string("ink")])
            XCTFail("Expected persistence failure")
        } catch { }
        try assertApplicationIcon(leaf: true, resourcesAt: root)
    }
}
