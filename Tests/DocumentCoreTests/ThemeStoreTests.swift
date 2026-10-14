import Foundation
import XCTest
@testable import DocumentCore

@MainActor final class ThemeStoreTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("MoriThemes-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("source"), withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fails(_ code: String = "invalidPath", _ action: () async throws -> Void) async {
        do { try await action(); XCTFail("Unsafe operation succeeded") }
        catch let error as DocumentError { XCTAssertEqual(error.code, code) }
        catch { XCTFail("Unexpected error: \(error)") }
    }

    func testPersonalCSSAndUnicodeNamesPersistAndUpdate() async throws {
        let root = try fixture(), profile = root.appendingPathComponent("profile"), store = ThemeStore(dataDirectory: profile)
        let initial = try await store.all(); XCTAssertEqual(initial, [])
        let css = ":root { --accent: blue; } body, #write, #document-sidebar { color: red; }"
        let theme = try await store.write(name: "한글 🌙 / personal", css: css)
        XCTAssertEqual(theme.id, "theme-1"); XCTAssertEqual(theme.name, "한글 🌙 / personal"); XCTAssertEqual(theme.css, css)
        let folder = try await store.folder(); XCTAssertEqual(folder, profile.appendingPathComponent("themes").path)
        XCTAssertEqual(try String(contentsOfFile: folder + "/theme-1.css", encoding: .utf8), css)
        let reopened = ThemeStore(dataDirectory: profile), restored = try await reopened.list(); XCTAssertEqual(restored, [theme])
        let updated = try await reopened.write(name: "새 이름", css: "#write { color: green; }", id: theme.id)
        let listed = try await store.all(); XCTAssertEqual(listed, [updated])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(updated)) as? [String: String]
        XCTAssertEqual(encoded, ["id": updated.id, "name": "새 이름", "css": "#write { color: green; }"])
    }

    func testDeterministicCollisionsRemovalAndOwnDeletion() async throws {
        let root = try fixture(), profile = root.appendingPathComponent("profile"), store = ThemeStore(dataDirectory: profile)
        let folder = try await store.folder(), unowned = URL(fileURLWithPath: folder).appendingPathComponent("theme-1.css")
        try Data("unowned".utf8).write(to: unowned)
        let first = try await store.write(name: "same", css: "a {}")
        let second = try await ThemeStore(dataDirectory: profile).write(name: "same", css: "b {}")
        XCTAssertEqual(first.id, "theme-2"); XCTAssertEqual(second.id, "theme-3")
        await fails("missing") { try await store.remove(id: "theme-1") }
        await fails("missing") { _ = try await store.write(name: "x", css: "x {}", id: "theme-1") }
        try await store.remove(id: first.id)
        let remaining = try await ThemeStore(dataDirectory: profile).list(); XCTAssertEqual(remaining, [second])
        XCTAssertEqual(try String(contentsOf: unowned, encoding: .utf8), "unowned")
        let replacement = try await store.write(name: "replacement", css: ""); XCTAssertEqual(replacement.id, "theme-2")
    }

    func testConcurrentInstancesDoNotLoseOwnership() async throws {
        let root = try fixture(), profile = root.appendingPathComponent("profile"), store = ThemeStore(dataDirectory: profile)
        async let first = store.write(name: "a", css: "a {}")
        async let second = ThemeStore(dataDirectory: profile).write(name: "b", css: "b {}")
        _ = try await (first, second)
        let themes = try await store.list(); XCTAssertEqual(themes.count, 2); XCTAssertEqual(Set(themes.map(\.id)).count, 2)
    }

    func testTraversalAndSymlinksCannotEscapeManagedFolder() async throws {
        let root = try fixture(), profile = root.appendingPathComponent("profile"), store = ThemeStore(dataDirectory: profile)
        let theme = try await store.write(name: "safe", css: "body {}")
        for id in ["../secret", "/tmp/file", "theme-1.css", "THEME-1", "theme-0", "theme-01", "theme-1:stream", "", "con", "theme-1\n"] {
            await fails { try await store.remove(id: id) }
            await fails { _ = try await store.write(name: "x", css: "a {}", id: id) }
        }
        let outside = root.appendingPathComponent("secret.css"), file = URL(fileURLWithPath: try await store.folder()).appendingPathComponent(theme.id + ".css")
        try Data("secret".utf8).write(to: outside); try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
        await fails { _ = try await store.list() }; await fails { try await store.remove(id: theme.id) }
        await fails { _ = try await store.write(name: "x", css: "x {}", id: theme.id) }
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "secret")
        let other = root.appendingPathComponent("other"); try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: other.appendingPathComponent("themes"), withDestinationURL: root)
        await fails { _ = try await ThemeStore(dataDirectory: other).folder() }
    }

    func testInvalidUTF8AndByteLimitsLeaveExistingThemeIntact() async throws {
        let root = try fixture(), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), file = root.appendingPathComponent("source/bad.css")
        let old = try await store.write(name: "old", css: "body {}")
        try Data([0xff, 0xfe, 0x61, 0]).write(to: file)
        await fails("invalidEncoding") { _ = try await store.importCSS(from: file) }
        try Data(repeating: 120, count: 1_048_577).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        await fails { _ = try await store.write(name: "too large", css: String(repeating: "한", count: 349_526), id: old.id) }
        await fails { _ = try await store.write(name: "", css: "x {}") }
        await fails { _ = try await store.write(name: "bad\0name", css: "x {}") }
        let textFile = root.appendingPathComponent("source/x.txt"); try Data("body {}".utf8).write(to: textFile)
        await fails { _ = try await store.importCSS(from: textFile) }
        await fails { _ = try await store.importCSS(from: URL(string: "https://example.com/theme.css")!) }
        let result = try await store.all(); XCTAssertEqual(result, [old])
        let limit = try await store.write(name: "boundary", css: String(repeating: "x", count: 1_048_576)); XCTAssertEqual(limit.css.utf8.count, 1_048_576)
    }

    func testImportsInlineLocalFontsImagesAndCSSAndSurviveSourceDeletion() async throws {
        let root = try fixture(), source = root.appendingPathComponent("source"), profile = root.appendingPathComponent("profile"), store = ThemeStore(dataDirectory: profile)
        try FileManager.default.createDirectory(at: source.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try Data([0, 1, 2, 255]).write(to: source.appendingPathComponent("assets/font.woff2"))
        try Data([1, 2, 3]).write(to: source.appendingPathComponent("assets/pic.png"))
        try Data("@font-face { src: url(\"assets/font.woff2\"); }".utf8).write(to: source.appendingPathComponent("base.css"))
        let css = "@import \"base.css\" screen;\n#write { background: url(assets/pic.png?v=1); }", file = source.appendingPathComponent("밤.CSS")
        try Data(css.utf8).write(to: file)
        let theme = try await store.importCSS(from: file)
        XCTAssertEqual(theme.name, "밤"); XCTAssertTrue(theme.css.contains("@media screen"))
        XCTAssertTrue(theme.css.contains("data:font/woff2;base64,AAEC/w==")); XCTAssertTrue(theme.css.contains("data:image/png;base64,AQID"))
        XCTAssertFalse(theme.css.contains("@import")); XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), css)
        try FileManager.default.removeItem(at: source)
        let restored = try await ThemeStore(dataDirectory: profile).list(); XCTAssertEqual(restored, [theme])
        let folder = try await store.folder(); XCTAssertEqual(try String(contentsOfFile: folder + "/" + theme.id + ".css", encoding: .utf8), theme.css)
    }

    func testUnsafeResourcePathsAndImportsFailBeforePersistence() async throws {
        let root = try fixture(), source = root.appendingPathComponent("source"), file = source.appendingPathComponent("main.css"), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile"))
        try Data("secret".utf8).write(to: root.appendingPathComponent("secret.png"))
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("link.png"), withDestinationURL: root.appendingPathComponent("secret.png"))
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("linked"), withDestinationURL: root)
        try Data("<svg/>".utf8).write(to: source.appendingPathComponent("bad.svg"))
        for css in [
            "body { background: url(../secret.png); }", "body { background: url(%2e%2e/secret.png); }",
            "body { background: url(/etc/passwd); }", "body { background: url(file:///etc/passwd); }",
            "body { background: url(C:/Windows/x.png); }", "body { background: url(link.png); }",
            "body { background: url(linked/secret.png); }", "body { background: url(bad.svg); }",
            "body { background: url(javascript:alert); }", "@import \"https://example.com/style.css\";",
            "@import \"../secret.css\";", "@import \"base.css\" layer(foo);", "@\\69mport \"base.css\";",
            "body { background: u\\72l(\"secret.png\"); }", "body { background: url(\"\\2e\\2e/secret.png\"); }"
        ] {
            try Data(css.utf8).write(to: file)
            await fails { _ = try await store.importCSS(from: file) }
        }
        let themes = try await store.list(); XCTAssertEqual(themes, [])
    }

    func testImportCyclesDepthAssetAndExpandedByteBounds() async throws {
        let root = try fixture(), source = root.appendingPathComponent("source"), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), file = source.appendingPathComponent("main.css")
        try Data("@import \"main.css\";".utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        for index in 0..<6 { try Data((index == 5 ? "body {}" : "@import \"d\(index + 1).css\";").utf8).write(to: source.appendingPathComponent("d\(index).css")) }
        await fails { _ = try await store.importCSS(from: source.appendingPathComponent("d0.css")) }
        try Data(repeating: 0, count: 524_289).write(to: source.appendingPathComponent("large.png"))
        try Data("body { background: url(large.png); }".utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        try Data(repeating: 120, count: 600_000).write(to: source.appendingPathComponent("base.css"))
        try Data("@import \"base.css\"; @import \"base.css\";".utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        let themes = try await store.list(); XCTAssertEqual(themes, [])
    }

    func testCommentsAndQuotedTextStayRawAndWritesRejectImports() async throws {
        let root = try fixture(), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), file = root.appendingPathComponent("source/text.css")
        let css = "/* @import \"ignored.css\"; url(../ignored) */ body::before { content: \"@import url(fake);\"; } body { background: url(https://example.com/p.png); mask: url(#shape); }"
        let written = try await store.write(name: "text", css: css); XCTAssertEqual(written.css, css)
        try Data(css.utf8).write(to: file)
        let imported = try await store.importCSS(from: file); XCTAssertEqual(imported.css, css)
        for css in ["@import \"local.css\";", "@IMPORT url(https://example.com/a.css);", "@\\69mport \"x.css\";"] {
            await fails { _ = try await store.write(name: "unsafe", css: css) }
        }
    }

    func testReadCountAndTotalImportByteBounds() async throws {
        let root = try fixture(), source = root.appendingPathComponent("source"), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), file = source.appendingPathComponent("main.css")
        try Data("x {}".utf8).write(to: source.appendingPathComponent("tiny.css"))
        try Data(String(repeating: "@import \"tiny.css\";", count: 64).utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        try Data(("@import \"tiny.css\" screen" + String(repeating: " ", count: 900_000) + ";").utf8).write(to: source.appendingPathComponent("spaces.css"))
        try Data(String(repeating: "@import \"spaces.css\";", count: 5).utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
        let themes = try await store.list(); XCTAssertEqual(themes, [])
    }

    func testQuotedUnicodeResourcesBOMAndHardlinkRejection() async throws {
        let root = try fixture(), source = root.appendingPathComponent("source"), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), file = source.appendingPathComponent("main.css")
        try FileManager.default.createDirectory(at: source.appendingPathComponent("sub"), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: source.appendingPathComponent("sub/한 글.woff"))
        try Data("@font-face { src: url(\"한%20글.woff\"); }".utf8).write(to: source.appendingPathComponent("sub/base.css"))
        try Data("\u{feff}@import url(\"sub/base.css\"); body::before { content: \"\\f000\"; }".utf8).write(to: file)
        let theme = try await store.importCSS(from: file)
        XCTAssertTrue(theme.css.contains("data:font/woff;base64,AQID")); XCTAssertTrue(theme.css.contains("content: \"\\f000\""))
        let outside = root.appendingPathComponent("outside.png"); try Data("secret".utf8).write(to: outside)
        try FileManager.default.linkItem(at: outside, to: source.appendingPathComponent("hard.png"))
        try Data("body { background: url(hard.png); }".utf8).write(to: file)
        await fails { _ = try await store.importCSS(from: file) }
    }

    func testUnsafeMetadataCannotAuthorizeDeletion() async throws {
        let root = try fixture(), store = ThemeStore(dataDirectory: root.appendingPathComponent("profile")), folder = URL(fileURLWithPath: try await store.folder()), index = folder.appendingPathComponent("_index.json")
        let outside = root.appendingPathComponent("outside.css"); try Data("secret".utf8).write(to: outside)
        try Data("[{\"id\":\"../outside\",\"name\":\"bad\"}]".utf8).write(to: index)
        await fails { _ = try await store.list() }; await fails { _ = try await store.write(name: "new", css: "body {}") }
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "secret")
        try FileManager.default.removeItem(at: index); try FileManager.default.createSymbolicLink(at: index, withDestinationURL: outside)
        await fails { _ = try await store.write(name: "new", css: "body {}") }
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "secret")
    }
}
