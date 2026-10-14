import Foundation
import XCTest
@testable import DocumentCore

private func expect(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(value, file: file, line: line)
}
private enum TestFailure: Error { case missingValue }
private func require<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let value else { XCTFail("Required value missing", file: file, line: line); throw TestFailure.missingValue }
    return value
}
private func expectError(_ expected: DocumentError, file: StaticString = #filePath, line: UInt = #line,
                         operation: () async throws -> Any) async {
    do { _ = try await operation(); XCTFail("Expected \(expected)", file: file, line: line) }
    catch { XCTAssertEqual(error as? DocumentError, expected, file: file, line: line) }
}
private func expectError(_ expected: (any Error).Type, file: StaticString = #filePath, line: UInt = #line,
                         operation: () async throws -> Any) async {
    do { _ = try await operation(); XCTFail("Expected typed DocumentError", file: file, line: line) }
    catch { XCTAssertTrue(error is DocumentError, "Unexpected error: \(error)", file: file, line: line) }
}

private struct Files {
    let root: URL
    let data: URL
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriCore-\(UUID().uuidString)", isDirectory: true)
        data = root.appendingPathComponent("state", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    func cleanup() { try? FileManager.default.removeItem(at: root) }
    func file(_ name: String, _ bytes: Data) throws -> URL {
        let url = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: url)
        return url
    }
}

final class DocumentTests: XCTestCase, @unchecked Sendable {
    func testEmptyAndUnicodeSaveAs() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.data)
        let empty = await store.create()
        expect(!empty.documentId.isEmpty)
        expect(empty.path == nil && empty.savedDigest == nil)
        let emptyURL = files.root.appendingPathComponent("empty.md")
        let saved = try await store.saveAs(id: empty.documentId, path: emptyURL.path, text: "", revision: 1)
        expect(try Data(contentsOf: emptyURL) == Data())
        expect(saved.savedDigest == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        let text = "한글 👩🏽‍💻 e\u{301}\r\n끝\r\n"
        let unicode = await store.create(text: text)
        expect(unicode.text == text)
        let url = files.root.appendingPathComponent("한글 문서.md")
        let result = try await store.saveAs(id: unicode.documentId, path: url.path, text: text, revision: 4)
        expect(result.revision == 4 && result.lineEnding == "CRLF")
        expect(try Data(contentsOf: url) == Data(text.utf8))
        expect(try await store.open(path: url.path).text == text)
    }

    func testEncodingRoundTrip() async throws {
        for encoding in ["utf8", "utf8bom", "utf16le", "utf16be"] {
            try await encodingRoundTrip(encoding: encoding)
        }
    }

    private func encodingRoundTrip(encoding: String) async throws {
        let files = try Files(); defer { files.cleanup() }
        let text = "한글 🐈 e\u{301}\r\n끝\r\n"
        let edited = "한글 🐈 e\u{301}\r\n끝!" // No final newline; the save must not add one.
        let (original, expected): (Data, Data)
        switch encoding {
        case "utf8": (original, expected) = (Data(text.utf8), Data(edited.utf8))
        case "utf8bom": (original, expected) = (Data([0xef, 0xbb, 0xbf]) + Data(text.utf8), Data([0xef, 0xbb, 0xbf]) + Data(edited.utf8))
        case "utf16le": (original, expected) = (Data([0xff, 0xfe]) + text.data(using: .utf16LittleEndian)!, Data([0xff, 0xfe]) + edited.data(using: .utf16LittleEndian)!)
        default: (original, expected) = (Data([0xfe, 0xff]) + text.data(using: .utf16BigEndian)!, Data([0xfe, 0xff]) + edited.data(using: .utf16BigEndian)!)
        }
        let url = try files.file("source.md", original)
        let store = DocumentStore(dataDirectory: files.data)
        let opened = try await store.open(path: url.path)
        expect(opened.encoding == encoding)
        expect(opened.text == text && opened.lineEnding == "CRLF")
        let saved = try await store.save(id: opened.documentId, text: edited, revision: 1)
        expect(saved.revision == 1)
        expect(try Data(contentsOf: url) == expected)
        expect(try await store.open(path: url.path).text == edited)
    }

    func testSaveDoesNotNormalizeLineEndings() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("mixed.md", Data("one\r\ntwo\n".utf8))
        let store = DocumentStore(dataDirectory: files.data)
        let doc = try await store.open(path: url.path)
        let text = "one\ntwo\r\nthree"
        _ = try await store.save(id: doc.documentId, text: text, revision: 2)
        expect(try Data(contentsOf: url) == Data(text.utf8))
    }

    func testExternalOverwriteAndDeletionAreConflicts() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("conflict.md", Data("abc".utf8))
        let store = DocumentStore(dataDirectory: files.data)
        let doc = try await store.open(path: url.path)
        // Same length and mtime: only byte digest validation catches this edit.
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        try Data("xyz".utf8).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: attributes[.modificationDate]!], ofItemAtPath: url.path)
        await expectError(DocumentError.conflict(url.path)) {
            try await store.save(id: doc.documentId, text: "mine", revision: 1)
        }
        expect(try Data(contentsOf: url) == Data("xyz".utf8))
        _ = try await store.save(id: doc.documentId, text: "mine", revision: 1, force: true)
        expect(try Data(contentsOf: url) == Data("mine".utf8))
        try FileManager.default.removeItem(at: url)
        await expectError(DocumentError.conflict(url.path)) {
            try await store.save(id: doc.documentId, text: "new", revision: 2)
        }
        expect(!FileManager.default.fileExists(atPath: url.path))
        _ = try await store.save(id: doc.documentId, text: "new", revision: 2, force: true)
        expect(try Data(contentsOf: url) == Data("new".utf8))
    }

    func testStaleRevisionsCannotReplaceDiskOrRecovery() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.data)
        let doc = await store.create()
        let url = files.root.appendingPathComponent("revision.md")
        _ = try await store.saveAs(id: doc.documentId, path: url.path, text: "saved", revision: 3)
        try await store.checkpoint(id: doc.documentId, text: "latest", revision: 5)
        await expectError((any Error).self) { try await store.save(id: doc.documentId, text: "stale", revision: 4, force: true) }
        await expectError((any Error).self) { try await store.checkpoint(id: doc.documentId, text: "stale", revision: 4) }
        expect(try Data(contentsOf: url) == Data("saved".utf8))
        let recovery = try require(try await store.recoveries().first)
        expect(recovery.text == "latest" && recovery.revision == 5)
        expect(recovery.savedDigest != nil)
        _ = try await store.save(id: doc.documentId, text: "latest", revision: 5)
        expect(try await store.recoveries().isEmpty)
    }

    func testUnsavedRecoverySurvivesCloseAndRestart() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.data)
        let doc = await store.create()
        try await store.checkpoint(id: doc.documentId, text: "복구 👋\r\n", revision: 9)
        await store.close(id: doc.documentId)
        let restarted = DocumentStore(dataDirectory: files.data)
        let found = try require(try await restarted.recoveries().first)
        expect(found.documentId == doc.documentId && found.revision == 9)
        expect(found.path == nil && found.text == "복구 👋\r\n")
        let restored = try await restarted.restore(id: doc.documentId)
        expect(restored == found)
        let url = files.root.appendingPathComponent("restored.md")
        _ = try await restarted.saveAs(id: doc.documentId, path: url.path, text: restored.text, revision: 9)
        expect(try Data(contentsOf: url) == Data("복구 👋\r\n".utf8))
        expect(try await restarted.recoveries().isEmpty)
    }

    func testRecoveredFileKeepsOriginalDigestAndBOM() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("recovery.md", Data([0xff, 0xfe, 0x41, 0x00, 0x0d, 0x00, 0x0a, 0x00]))
        let store = DocumentStore(dataDirectory: files.data)
        let doc = try await store.open(path: url.path)
        try await store.checkpoint(id: doc.documentId, text: "B\r\n", revision: 7)
        await store.close(id: doc.documentId)
        try Data("external".utf8).write(to: url)
        let restarted = DocumentStore(dataDirectory: files.data)
        let restored = try await restarted.restore(id: doc.documentId)
        expect(restored.savedDigest == doc.savedDigest)
        await expectError(DocumentError.conflict(url.path)) { try await restarted.save(id: doc.documentId, text: restored.text, revision: 7) }
        _ = try await restarted.save(id: doc.documentId, text: restored.text, revision: 7, force: true)
        expect(try Data(contentsOf: url) == Data([0xff, 0xfe, 0x42, 0x00, 0x0d, 0x00, 0x0a, 0x00]))
    }

    func testSaveAsDoesNotClobberExistingTarget() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("exists.md", Data("existing".utf8))
        let store = DocumentStore(dataDirectory: files.data)
        let doc = await store.create(text: "mine")
        await expectError(DocumentError.conflict(url.path)) { try await store.saveAs(id: doc.documentId, path: url.path, text: "mine", revision: 1) }
        expect(try Data(contentsOf: url) == Data("existing".utf8))
        _ = try await store.saveAs(id: doc.documentId, path: url.path, text: "mine", revision: 1, overwrite: true)
        expect(try Data(contentsOf: url) == Data("mine".utf8))
    }

    func testBOMlessUTF16AndMalformedSurrogates() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.data)
        for (bytes, encoding) in [(Data([0x41, 0x00, 0x0a, 0x00]), "utf16le"), (Data([0x00, 0x41, 0x00, 0x0a]), "utf16be")] {
            let url = try files.file("\(encoding).md", bytes)
            let doc = try await store.open(path: url.path)
            expect(doc.text == "A\n" && doc.encoding == encoding)
            _ = try await store.save(id: doc.documentId, text: "A\n", revision: 1)
            expect(try Data(contentsOf: url) == bytes)
        }
        for (index, bytes) in [Data([0xff, 0xfe, 0x00, 0xd8]), Data([0xfe, 0xff, 0xdc, 0x00]), Data([0xff, 0xfe, 0x41])].enumerated() {
            let url = try files.file("bad-\(index).md", bytes)
            await expectError(DocumentError.invalidEncoding(url.path)) { try await store.open(path: url.path) }
            expect(try Data(contentsOf: url) == bytes)
        }
    }

    func testFailedSavePreservesCheckpointAndRemovesTemporaryFile() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("original.md", Data("base".utf8))
        let store = DocumentStore(dataDirectory: files.data)
        let doc = try await store.open(path: url.path)
        try await store.checkpoint(id: doc.documentId, text: "mine", revision: 1)
        try Data("external".utf8).write(to: url)
        await expectError(DocumentError.conflict(url.path)) { try await store.save(id: doc.documentId, text: "mine", revision: 1) }
        expect(try await store.recoveries().first?.text == "mine")
        expect(try Data(contentsOf: url) == Data("external".utf8))
        expect(try FileManager.default.contentsOfDirectory(atPath: files.root.path).filter { $0.hasPrefix(".mori-") }.isEmpty)
    }

    func testTypedErrorsLeaveInvalidFilesUntouched() async throws {
        let files = try Files(); defer { files.cleanup() }
        let bad = try files.file("bad.md", Data([0xef, 0xbb, 0xbf, 0xff]))
        let store = DocumentStore(dataDirectory: files.data)
        await expectError(DocumentError.invalidEncoding(bad.path)) { try await store.open(path: bad.path) }
        let missing = files.root.appendingPathComponent("missing.md").path
        await expectError(DocumentError.missing(missing)) { try await store.open(path: missing) }
        await expectError(DocumentError.invalidPath("relative.md")) { try await store.open(path: "relative.md") }
        await expectError(DocumentError.unknownDocument("missing")) { try await store.save(id: "missing", text: "", revision: 0) }
        expect(try Data(contentsOf: bad) == Data([0xef, 0xbb, 0xbf, 0xff]))
    }
}

final class WorkspaceTests: XCTestCase, @unchecked Sendable {
    func testLazyNestedDirectoryListing() async throws {
        let files = try Files(); defer { files.cleanup() }
        _ = try files.file("tree/nested/child.md", Data("child".utf8))
        let leaf = try files.file("tree/root.md", Data("root".utf8))
        let store = WorkspaceStore(dataDirectory: files.data)
        let entries = try await store.listDirectory(path: leaf.deletingLastPathComponent().path)
        expect(entries.map(\.name) == ["nested", "root.md"])
        expect(entries[0].isDirectory && !entries[1].isDirectory)
        expect(entries[1].size == 4 && entries[1].modified > 0)
        expect(try await store.listDirectory(path: entries[0].path).map(\.name) == ["child.md"])
    }

    func testRecursiveSearchHasUnicodeOffsetsAndLimits() async throws {
        let files = try Files(); defer { files.cleanup() }
        let root = try files.file("tree/a.md", Data("🐈 Mori\r\nmori Mori\r\n".utf8)).deletingLastPathComponent()
        _ = try files.file("tree/nested/b.md", Data("MORI\n".utf8))
        _ = try files.file("tree/binary.png", Data([0xff, 0xfe, 0xff]))
        let store = WorkspaceStore(dataDirectory: files.data)
        let found = try await store.search(path: root.path, query: "mori")
        expect(found.count == 4)
        expect(found[0].line == 1 && found[0].text == "🐈 Mori")
        expect(found[0].from == 3 && found[0].to == 7)
        expect(found[1].line == 2 && found[1].from == 0 && found[2].from == 5)
        expect(try await store.search(path: root.path, query: "Mori", caseSensitive: true).count == 2)
        expect(try await store.search(path: root.path, query: "M[a-z]+", regex: true, limit: 2).count == 2)
        expect(try await store.search(path: root.path, query: "Mori", limit: 0).isEmpty)
        await expectError((any Error).self) { try await store.search(path: root.path, query: "[", regex: true) }
    }

    func testCanonicalAssetContainmentRejectsTraversalAndSymlinks() async throws {
        let files = try Files(); defer { files.cleanup() }
        let asset = try files.file("workspace/assets/a.png", Data([1, 2, 3]))
        let outside = try files.file("workspace-other/private.png", Data([9]))
        let root = asset.deletingLastPathComponent().deletingLastPathComponent()
        let link = root.appendingPathComponent("escape")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside.deletingLastPathComponent())
        let store = WorkspaceStore(dataDirectory: files.data)
        expect(try await store.readAsset(path: "assets/a.png", root: root.path) == Data([1, 2, 3]))
        expect(try await store.readAsset(path: asset.path, root: root.path) == Data([1, 2, 3]))
        await expectError((any Error).self) { try await store.readAsset(path: "../workspace-other/private.png", root: root.path) }
        await expectError((any Error).self) { try await store.readAsset(path: outside.path, root: root.path) }
        await expectError((any Error).self) { try await store.readAsset(path: "escape/private.png", root: root.path) }
    }

    func testSearchDoesNotFollowOutsideDirectorySymlinks() async throws {
        let files = try Files(); defer { files.cleanup() }
        let root = try files.file("tree/a.md", Data("inside".utf8)).deletingLastPathComponent()
        let outside = try files.file("outside/secret.md", Data("secret".utf8))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: outside.deletingLastPathComponent())
        let store = WorkspaceStore(dataDirectory: files.data)
        expect(try await store.search(path: root.path, query: "secret").isEmpty)
    }

    func testAssetCollisionsKeepExistingBytesAndSources() async throws {
        let files = try Files(); defer { files.cleanup() }
        let first = try files.file("one/photo.png", Data([1]))
        let second = try files.file("two/photo.png", Data([2]))
        let existing = try files.file("assets/photo.png", Data([0]))
        let store = WorkspaceStore(dataDirectory: files.data)
        let paths = try await store.importAssets(paths: [first.path, second.path], directory: existing.deletingLastPathComponent().path)
        expect(paths.count == 2 && paths[0] != paths[1] && !paths.contains(existing.path))
        expect(try Data(contentsOf: URL(fileURLWithPath: paths[0])) == Data([1]))
        expect(try Data(contentsOf: URL(fileURLWithPath: paths[1])) == Data([2]))
        expect(try Data(contentsOf: existing) == Data([0]))
        expect(try Data(contentsOf: first) == Data([1]))
    }

    func testDeleteSymlinkRemovesLinkAndPreservesTarget() async throws {
        let files = try Files(); defer { files.cleanup() }
        let target = try files.file("outside/target.md", Data("keep".utf8))
        let link = files.root.appendingPathComponent("shortcut.md")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let store = WorkspaceStore(dataDirectory: files.data)
        _ = try await store.manage(operation: "delete", path: link.path, destination: nil)
        expect(!FileManager.default.fileExists(atPath: link.path))
        expect(FileManager.default.fileExists(atPath: target.path))
        expect(try Data(contentsOf: target) == Data("keep".utf8))
    }

    func testManageCreatesCopiesRenamesMovesWithoutOverwrite() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = WorkspaceStore(dataDirectory: files.data)
        let folder = files.root.appendingPathComponent("managed").path
        expect(try await store.manage(operation: "createDirectory", path: folder, destination: nil) == folder)
        let file = URL(fileURLWithPath: folder).appendingPathComponent("new.md").path
        _ = try await store.manage(operation: "createFile", path: file, destination: nil)
        expect(try Data(contentsOf: URL(fileURLWithPath: file)).isEmpty)
        try Data("original".utf8).write(to: URL(fileURLWithPath: file))
        let copied = files.root.appendingPathComponent("copy.md").path
        _ = try await store.manage(operation: "copy", path: file, destination: copied)
        await expectError(DocumentError.conflict(copied)) { try await store.manage(operation: "copy", path: file, destination: copied) }
        let renamed = files.root.appendingPathComponent("renamed.md").path
        _ = try await store.manage(operation: "rename", path: copied, destination: renamed)
        let moved = files.root.appendingPathComponent("moved.md").path
        _ = try await store.manage(operation: "move", path: renamed, destination: moved)
        expect(!FileManager.default.fileExists(atPath: renamed))
        expect(try Data(contentsOf: URL(fileURLWithPath: moved)) == Data("original".utf8))
        await expectError((any Error).self) { try await store.manage(operation: "execute", path: file, destination: nil) }
    }
}

final class SettingsTests: XCTestCase, @unchecked Sendable {
    func testFoundationConversionPreservesJSONTypes() throws {
        let bytes = Data(#"{"enabled":true,"count":1,"fraction":1.5,"null":null,"strings":["한글"],"nested":{"off":false}}"#.utf8)
        let foundation = try JSONSerialization.jsonObject(with: bytes)
        let json = try JSONValue(foundationValue: foundation)
        expect(json == .object(["enabled": .bool(true), "count": .number(1), "fraction": .number(1.5), "null": .null, "strings": .array([.string("한글")]), "nested": .object(["off": .bool(false)])]))
        let encoded = try JSONSerialization.data(withJSONObject: json.foundationValue)
        expect(try JSONDecoder().decode(JSONValue.self, from: encoded) == json)
        do { _ = try JSONValue(foundationValue: Date()); XCTFail("Unsupported Foundation value accepted") }
        catch { expect(error is DocumentError) }
    }

    func testMergePersistsOrdinaryJSONTypes() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = SettingsStore(dataDirectory: files.data)
        expect(try await store.all().isEmpty)
        let values: [String: JSONValue] = ["theme": .string("dark"), "fontSize": .number(16), "wrap": .bool(true), "recent": .array([.string("한글.md")]), "nested": .object(["empty": .null])]
        expect(try await store.update(values: values) == values)
        let second = SettingsStore(dataDirectory: files.data)
        let merged = try await second.update(values: ["theme": .string("light")])
        expect(merged["theme"] == .string("light") && merged["wrap"] == .bool(true))
        expect(try await store.all() == merged)
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: files.data.appendingPathComponent("settings.json"))) as? [String: Any]
        expect(json?["theme"] as? String == "light")
        expect(json?["fontSize"] as? Int == 16)
    }

    func testMalformedSettingsAndWriteFailuresAreTypedAndPreserveDisk() async throws {
        let files = try Files(); defer { files.cleanup() }
        let url = try files.file("state/settings.json", Data("{".utf8))
        let store = SettingsStore(dataDirectory: files.data)
        await expectError((any Error).self) { try await store.all() }
        await expectError((any Error).self) { try await store.update(values: ["x": .bool(true)]) }
        expect(try Data(contentsOf: url) == Data("{".utf8))
        let blocked = try files.file("blocked", Data("file".utf8))
        let failed = SettingsStore(dataDirectory: blocked)
        await expectError((any Error).self) { try await failed.update(values: ["x": .bool(true)]) }
        expect(try Data(contentsOf: blocked) == Data("file".utf8))
    }
}
