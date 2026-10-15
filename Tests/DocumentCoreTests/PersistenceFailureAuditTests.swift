import Foundation
import XCTest
@testable import DocumentCore

@MainActor
final class PersistenceFailureAuditTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafPersistenceAudit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    func testBoundSaveRejectsSymlinkReplacementWithoutWritingAnotherFile() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("original.md"), other = root.appendingPathComponent("other.md")
        let base = Data("same original bytes".utf8), draft = "unsaved 한글 👩🏽‍💻\r\n"
        try base.write(to: file); try base.write(to: other)
        let store = DocumentStore(dataDirectory: root.appendingPathComponent("state"))
        let document = try await store.open(path: file.path)
        try await store.checkpoint(id: document.documentId, text: draft, revision: 1)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: other)
        do {
            _ = try await store.save(id: document.documentId, text: draft, revision: 2,
                expectedDigest: document.savedDigest, enforceExpectedDigest: true)
            XCTFail("A bound save followed a replacement symlink")
        } catch { XCTAssertTrue(error is DocumentError) }
        XCTAssertEqual(try Data(contentsOf: other), base, "Saving must not write a different file with the same base digest")
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: file.path), other.path)
        let recoveries = try await store.recoveries()
        XCTAssertEqual(recoveries.first?.text, draft)
        try FileManager.default.removeItem(at: file)
        try base.write(to: file)
        _ = try await store.save(id: document.documentId, text: draft, revision: 2)
        XCTAssertEqual(try Data(contentsOf: file), Data(draft.utf8))
        XCTAssertEqual(try Data(contentsOf: other), base)
    }

    func testRebindUpdatesPersistedCheckpointForMoveAndDetachedDocument() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        for detach in [false, true] {
            let folder = root.appendingPathComponent(detach ? "detach" : "move")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("before.md"), moved = folder.appendingPathComponent("after.md")
            try Data("saved".utf8).write(to: file)
            let data = folder.appendingPathComponent("state"), store = DocumentStore(dataDirectory: data)
            let document = try await store.open(path: file.path)
            let draft = "edits after saved bytes\r\n한글 😀"
            try await store.checkpoint(id: document.documentId, text: draft, revision: 3)
            if detach { try FileManager.default.removeItem(at: file) }
            else { try FileManager.default.moveItem(at: file, to: moved) }
            _ = try await store.rebind(id: document.documentId, path: detach ? nil : moved.path)
            await store.closeAll()
            let relaunched = DocumentStore(dataDirectory: data)
            let restored = try await relaunched.restoreSession(id: document.documentId, path: detach ? nil : moved.path)
            XCTAssertEqual(restored.path, detach ? nil : moved.path, "Recovery must retain the latest managed-file binding")
            XCTAssertEqual(restored.savedDigest, detach ? nil : document.savedDigest)
            XCTAssertEqual(restored.text, draft); XCTAssertEqual(restored.revision, 3)
            guard restored.path == (detach ? nil : moved.path) else { continue }
            if detach { _ = try await relaunched.saveAs(id: restored.documentId, path: moved.path, text: draft, revision: 4) }
            else { _ = try await relaunched.save(id: restored.documentId, text: draft, revision: 4) }
            XCTAssertEqual(try Data(contentsOf: moved), Data(draft.utf8))
        }
    }

    func testBoundReloadAndManagedPreflightRejectReplacementSymlink() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("bound.md"), other = root.appendingPathComponent("other.md")
        try Data("base".utf8).write(to: file); try Data("base".utf8).write(to: other)
        let store = DocumentStore(dataDirectory: root.appendingPathComponent("state"))
        let document = try await store.open(path: file.path)
        try await store.checkpoint(id: document.documentId, text: "my unsaved draft", revision: 1)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: other)
        do { _ = try await store.verifySaved(id: document.documentId); XCTFail("Managed-file preflight followed a replacement link") }
        catch { XCTAssertTrue(error is DocumentError) }
        try Data("different foreign document".utf8).write(to: other)
        do { _ = try await store.reload(id: document.documentId, revision: 2); XCTFail("Reload followed a replacement link") }
        catch { XCTAssertTrue(error is DocumentError) }
        let recovery = try await store.recoveries()
        XCTAssertEqual(recovery.first?.text, "my unsaved draft")
        XCTAssertEqual(try Data(contentsOf: other), Data("different foreign document".utf8))
    }

    func testUnreadableRecoveryIsNotTreatedAsMissingDuringBindingOrCleanCheckpoint() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        for operation in ["rebind", "clean-checkpoint"] {
            let folder = root.appendingPathComponent(operation)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("before.md"), destination = folder.appendingPathComponent("after.md")
            try Data("base".utf8).write(to: file); try Data("base".utf8).write(to: destination)
            let data = folder.appendingPathComponent("state"), store = DocumentStore(dataDirectory: data)
            let document = try await store.open(path: file.path)
            try await store.checkpoint(id: document.documentId, text: "draft", revision: 1)
            let recoveries = data.appendingPathComponent("recoveries")
            try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: recoveries.path)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: recoveries.path) }
            do {
                if operation == "rebind" { _ = try await store.rebind(id: document.documentId, path: destination.path) }
                else { try await store.checkpoint(id: document.documentId, text: "base", revision: 2) }
                XCTFail("\(operation) silently treated an inaccessible recovery as absent")
            } catch { XCTAssertTrue(error is DocumentError) }
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: recoveries.path)
            let current = try await store.keepRecovery(id: document.documentId, revision: 1)
            XCTAssertEqual(current.path, file.path); XCTAssertEqual(current.text, "draft")
            let kept = try await store.recoveries(); XCTAssertEqual(kept.first?.text, "draft")
        }
    }
}
