import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class PersistenceAuditBridgeTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafNativePersistence-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    private func bridge(_ root: URL, windowID: String = "audit", view: WKWebView? = nil) throws -> Bridge {
        _ = NSApplication.shared
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", root.path, "--data-dir", root.appendingPathComponent("state").path])
        return Bridge(webView: view ?? WKWebView(frame: .zero, configuration: configuration), options: options, windowID: windowID, inheritLegacySession: false)
    }
    private func call(_ bridge: Bridge, _ method: String, _ args: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await bridge.dispatch(NativeRequest(id: 1, method: method, args: args))
    }
    private func object(_ value: JSONValue) throws -> [String: JSONValue] {
        guard case .object(let object) = value else { throw BridgeError.invalidRequest("Expected audit object") }
        return object
    }
    private func snapshot(_ value: JSONValue) throws -> DocumentSnapshot {
        try JSONDecoder().decode(DocumentSnapshot.self, from: JSONEncoder().encode(value))
    }
    private func failure(_ bridge: Bridge, _ method: String, _ args: [String: JSONValue], code: String) async {
        do { _ = try await call(bridge, method, args); XCTFail("Expected \(method) to fail with \(code)") }
        catch let error as DocumentError { XCTAssertEqual(error.code, code) }
        catch let error as BridgeError { XCTAssertEqual(error.code, code) }
        catch { XCTFail("Unexpected error: \(error)") }
    }
    private func bytes(_ text: String, encoding: String, bom: Bool) -> Data {
        switch encoding {
        case "utf8": return Data(text.utf8)
        case "utf8bom": return Data([0xef, 0xbb, 0xbf]) + Data(text.utf8)
        case "utf16le": return (bom ? Data([0xff, 0xfe]) : Data()) + text.data(using: .utf16LittleEndian)!
        default: return (bom ? Data([0xfe, 0xff]) : Data()) + text.data(using: .utf16BigEndian)!
        }
    }

    func testEncodingWatchConflictCopyAndRestartMatrixChecksActualBytes() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        for (encoding, bom) in [("utf8", false), ("utf8bom", true), ("utf16le", true), ("utf16be", true), ("utf16le", false), ("utf16be", false)] {
            for ending in ["\n", "\r\n"] {
                let folder = root.appendingPathComponent("\(encoding)-\(bom)-\(ending == "\n" ? "LF" : "CRLF")")
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let original = "한글 👩🏽‍💻 e\u{301}" + ending + "# Base", external = "한글 👩🏽‍💻 e\u{301}" + ending + "# Else"
                let draft = original + ending + "수정 😀\n마지막 줄"
                let source = folder.appendingPathComponent("한글 원본.md"), copy = folder.appendingPathComponent("복사본.md")
                let originalBytes = bytes(original, encoding: encoding, bom: bom), externalBytes = bytes(external, encoding: encoding, bom: bom)
                XCTAssertEqual(originalBytes.count, externalBytes.count)
                try originalBytes.write(to: source)
                let owner = try bridge(folder), opened = try snapshot(await call(owner, "openDocument", ["path": .string(source.path)]))
                XCTAssertEqual(opened.encoding, encoding); XCTAssertEqual(opened.text, original)
                let id = JSONValue.string(opened.documentId)
                _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string(draft), "revision": .number(1)])
                try externalBytes.write(to: source)
                let watched = try object(await call(owner, "observeDocument", ["documentId": id]))
                XCTAssertEqual(watched["status"], .string("modified"))
                await failure(owner, "saveDocument", ["documentId": id, "text": .string(draft), "revision": .number(1), "expectedDigest": opened.savedDigest.map(JSONValue.string) ?? .null], code: "conflict")
                XCTAssertEqual(try Data(contentsOf: source), externalBytes)
                let kept = try await owner.documents.recoveries(); XCTAssertEqual(kept.first?.text, draft)
                let saved = try snapshot(await call(owner, "saveAs", ["documentId": id, "text": .string(draft), "revision": .number(2), "path": .string(copy.path)]))
                XCTAssertEqual(try Data(contentsOf: copy), bytes(draft, encoding: encoding, bom: bom))
                XCTAssertEqual(try Data(contentsOf: source), externalBytes)
                _ = try await call(owner, "closeDocument", ["documentId": id])
                let restarted = try bridge(folder, windowID: "restarted")
                let restored = try snapshot(await call(restarted, "restoreDocument", ["documentId": id, "path": .string(copy.path)]))
                XCTAssertEqual(restored.documentId, opened.documentId); XCTAssertEqual(restored.text, draft)
                XCTAssertEqual(restored.encoding, encoding); XCTAssertEqual(restored.savedDigest, saved.savedDigest)
                _ = try await call(restarted, "setDocumentFormat", ["documentId": id, "text": .string(draft), "revision": .number(1), "encoding": .string("utf8bom")])
                XCTAssertEqual(try Data(contentsOf: copy), bytes(draft, encoding: encoding, bom: bom), "Format changes alone must not write disk")
                _ = try await call(restarted, "saveDocument", ["documentId": id, "text": .string(draft), "revision": .number(2), "expectedDigest": saved.savedDigest.map(JSONValue.string) ?? .null])
                XCTAssertEqual(try Data(contentsOf: copy), bytes(draft, encoding: "utf8bom", bom: true))
                let clean = try await restarted.documents.recoveries(); XCTAssertTrue(clean.isEmpty)
                print("PERSISTENCE_MATRIX \(encoding) bom=\(bom) eol=\(ending == "\n" ? "LF" : "CRLF") passed byte conflict/copy/restart/format sequence")
            }
        }
    }

    func testFailedAutomaticSaveCanRetryThenRecoverAfterExternalDeletion() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("files")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path) }
        let file = folder.appendingPathComponent("note.md"), original = Data("saved".utf8), draft = "new 한글\r\n😀"
        try original.write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o640], ofItemAtPath: file.path)
        let owner = try bridge(root), opened = try snapshot(await call(owner, "openDocument", ["path": .string(file.path)]))
        let id = JSONValue.string(opened.documentId)
        _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string(draft), "revision": .number(1)])
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: folder.path)
        let save: [String: JSONValue] = ["documentId": id, "text": .string(draft), "revision": .number(1), "expectedDigest": opened.savedDigest.map(JSONValue.string) ?? .null]
        await failure(owner, "saveDocument", save, code: "io")
        XCTAssertEqual(try Data(contentsOf: file), original)
        let failedRecovery = try await owner.documents.recoveries(); XCTAssertEqual(failedRecovery.first?.text, draft)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
        _ = try await call(owner, "saveDocument", save)
        XCTAssertEqual(try Data(contentsOf: file), Data(draft.utf8))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o640)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: folder.path).contains { $0.hasPrefix(".mori-") })
        try FileManager.default.removeItem(at: file)
        let newer = draft + "\nmore edits"
        _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string(newer), "revision": .number(2)])
        let missing = try object(await call(owner, "observeDocument", ["documentId": id]))
        XCTAssertEqual(missing["status"], .string("missing"))
        await failure(owner, "saveDocument", ["documentId": id, "text": .string(newer), "revision": .number(2)], code: "conflict")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        let destination = folder.appendingPathComponent("rescued.md")
        _ = try await call(owner, "saveAs", ["documentId": id, "text": .string(newer), "revision": .number(3), "path": .string(destination.path)])
        XCTAssertEqual(try Data(contentsOf: destination), Data(newer.utf8))
    }

    func testCreateRenameCheckpointMoveCollisionAndNativeTrash() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let owner = try bridge(root), draft = try snapshot(await call(owner, "createDocument")), id = JSONValue.string(draft.documentId)
        let original = root.appendingPathComponent("audit-\(UUID().uuidString).md"), renamed = root.appendingPathComponent("renamed-\(UUID().uuidString).md")
        let content = "owned audit bytes \(UUID().uuidString)\n한글 😀"
        _ = try await call(owner, "saveAs", ["documentId": id, "text": .string(content), "revision": .number(1), "path": .string(original.path)])
        _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string(content + " edits"), "revision": .number(2)])
        let rename = try object(await call(owner, "manageFile", ["documentId": id, "operation": .string("rename"), "path": .string(original.path), "destination": .string(renamed.path)]))
        XCTAssertEqual(try snapshot(XCTUnwrap(rename["document"])).path, renamed.path)
        try await owner.removeWindowSession(keepSession: true)
        let restarted = try bridge(root, windowID: "new-owner")
        let recovery = try snapshot(await call(restarted, "restoreDocument", ["documentId": id, "path": .string(renamed.path)]))
        XCTAssertEqual(recovery.path, renamed.path); XCTAssertEqual(recovery.text, content + " edits")
        let committed = content + " edits"
        _ = try await call(restarted, "saveDocument", ["documentId": id, "text": .string(committed), "revision": .number(3)])
        let folder = root.appendingPathComponent("moved")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let moved = folder.appendingPathComponent(renamed.lastPathComponent), collision = folder.appendingPathComponent("existing.md")
        try Data("unrelated".utf8).write(to: collision)
        _ = try await call(restarted, "manageFile", ["documentId": id, "operation": .string("move"), "path": .string(renamed.path), "destination": .string(moved.path)])
        await failure(restarted, "manageFile", ["documentId": id, "operation": .string("rename"), "path": .string(moved.path), "destination": .string(collision.path)], code: "conflict")
        XCTAssertEqual(try Data(contentsOf: moved), Data(committed.utf8)); XCTAssertEqual(try Data(contentsOf: collision), Data("unrelated".utf8))
        let trashed = try object(await call(restarted, "manageFile", ["documentId": id, "operation": .string("trash"), "path": .string(moved.path)]))
        let detached = try snapshot(XCTUnwrap(trashed["document"])); XCTAssertNil(detached.path); XCTAssertNil(detached.savedDigest)
        guard case .string(let path) = trashed["path"] else { return XCTFail("Native Trash returned no resulting path") }
        let result = URL(fileURLWithPath: path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: moved.path))
        XCTAssertEqual(try Data(contentsOf: result), Data(committed.utf8))
        // Remove only the test's uniquely named, byte-verified Trash entry.
        if try Data(contentsOf: result) == Data(committed.utf8), result.lastPathComponent.contains("renamed-") {
            try FileManager.default.removeItem(at: result)
        }
        print("PERSISTENCE_TRASH actual native operation and owned-entry cleanup passed")
    }

    func testPartialAssetPublicationRollsBackAndRetriesWithUTF16AndUnicodeOffsets() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let assets = root.appendingPathComponent("source/assets"), output = root.appendingPathComponent("target")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let first = assets.appendingPathComponent("a b.png"), second = assets.appendingPathComponent("second.png")
        try Data([1, 2, 3]).write(to: first)
        let existing = output.appendingPathComponent("assets/a b.png"); try Data([99]).write(to: existing)
        let text = "😀 ![first](assets/a%20b.png#zoom)\r\n<img src=\"assets/second.png?x=1&amp;y=2\">"
        let ns = text as NSString, firstRange = ns.range(of: "assets/a%20b.png#zoom"), secondRange = ns.range(of: "assets/second.png?x=1&amp;y=2")
        func reference(_ file: URL, _ range: NSRange, html: Bool, suffix: String) -> JSONValue {
            .object(["path": .string(file.path), "from": .number(Double(range.location)), "to": .number(Double(NSMaxRange(range))), "html": .bool(html), "suffix": .string(suffix)])
        }
        let refs = JSONValue.array([reference(first, firstRange, html: false, suffix: "#zoom"), reference(second, secondRange, html: true, suffix: "?x=1&y=2")])
        let owner = try bridge(root), created = try snapshot(await call(owner, "createDocument", ["text": .string(text)])), id = JSONValue.string(created.documentId)
        _ = try await call(owner, "setDocumentFormat", ["documentId": id, "text": .string(text), "revision": .number(1), "encoding": .string("utf16be")])
        _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string(text), "revision": .number(1)])
        let destination = output.appendingPathComponent("문서.md")
        let request: [String: JSONValue] = ["documentId": id, "text": .string(text), "revision": .number(2), "path": .string(destination.path), "assetRoot": .string(assets.deletingLastPathComponent().path), "imageReferences": refs]
        await failure(owner, "saveAs", request, code: "missing")
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.appendingPathComponent("assets").path), ["a b.png"])
        XCTAssertEqual(try Data(contentsOf: existing), Data([99])); XCTAssertEqual(try Data(contentsOf: first), Data([1, 2, 3]))
        let recoveries = try await owner.documents.recoveries(); XCTAssertEqual(recoveries.first?.text, text)
        try Data([4, 5, 6]).write(to: second)
        let saved = try snapshot(await call(owner, "saveAs", request))
        let expected = "😀 ![first](assets/a%20b-1.png#zoom)\r\n<img src=\"assets/second.png?x=1&amp;y=2\">"
        XCTAssertEqual(saved.text, expected)
        XCTAssertEqual(try Data(contentsOf: destination), bytes(expected, encoding: "utf16be", bom: true))
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("assets/a b-1.png")), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("assets/second.png")), Data([4, 5, 6]))
        let clean = try await owner.documents.recoveries(); XCTAssertTrue(clean.isEmpty)
    }

    func testManagedMoveRollsBackWhenCheckpointBindingCannotBePersisted() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        for operation in ["move", "rename", "trash"] {
            let folder = root.appendingPathComponent(operation)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("rollback-\(UUID().uuidString).md"), destination = folder.appendingPathComponent("after.md")
            try Data("saved".utf8).write(to: file)
            let owner = try bridge(folder), document = try snapshot(await call(owner, "openDocument", ["path": .string(file.path)]))
            let id = JSONValue.string(document.documentId)
            _ = try await call(owner, "checkpoint", ["documentId": id, "text": .string("unsaved changes"), "revision": .number(1)])
            let recoveries = folder.appendingPathComponent("state/recoveries")
            try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: recoveries.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: recoveries.path) }
            await failure(owner, "manageFile", ["documentId": id, "path": .string(file.path), "destination": .string(destination.path), "operation": .string(operation)], code: "io")
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "A failed \(operation) binding transaction must restore the source entry")
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
            let observed = try object(await call(owner, "observeDocument", ["documentId": id]))
            XCTAssertEqual(observed["status"], .string("unchanged"))
            let kept = try await owner.documents.recoveries(); XCTAssertEqual(kept.first?.text, "unsaved changes")
            XCTAssertEqual(kept.first?.path, file.path)
            print("PERSISTENCE_ROLLBACK \(operation) restored source and preserved checkpoint after binding write failure")
        }
    }
}
