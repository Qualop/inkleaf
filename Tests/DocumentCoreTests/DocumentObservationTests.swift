import Darwin
import XCTest
@testable import DocumentCore

final class DocumentObservationTests: XCTestCase, @unchecked Sendable {
    private let abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    private let xyzDigest = "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282"

    private struct Files {
        let root: URL
        var state: URL { root.appendingPathComponent("state") }
        var file: URL { root.appendingPathComponent("note.md") }
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriObservation-\(UUID().uuidString)").resolvingSymlinksInPath()
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
        func cleanup() { try? FileManager.default.removeItem(at: root) }
    }

    func testSameLengthExternalWriteChangesDigestWithoutChangingTheSaveBaseline() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), opened = try await store.open(path: files.file.path)
        try await store.checkpoint(id: opened.documentId, text: "draft", revision: 5)
        let unchanged = try await store.observe(id: opened.documentId)
        XCTAssertEqual(unchanged.status, .unchanged); XCTAssertEqual(unchanged.diskDigest, abcDigest)
        try Data("abc".utf8).write(to: files.file, options: .atomic)
        let same = try await store.observe(id: opened.documentId)
        XCTAssertEqual(same, unchanged)
        let attributes = try FileManager.default.attributesOfItem(atPath: files.file.path)
        try Data("xyz".utf8).write(to: files.file)
        try FileManager.default.setAttributes([.modificationDate: attributes[.modificationDate]!], ofItemAtPath: files.file.path)
        for _ in 0..<2 {
            let observation = try await store.observe(id: opened.documentId)
            XCTAssertEqual(observation.status, .modified); XCTAssertEqual(observation.diskDigest, xyzDigest)
        }
        do {
            _ = try await store.save(id: opened.documentId, text: "draft", revision: 5)
            XCTFail("Observation must not adopt external bytes as the saved baseline")
        } catch { XCTAssertEqual(error as? DocumentError, .conflict(files.file.path)) }
        try Data("abc".utf8).write(to: files.file)
        let current = try await store.verifySaved(id: opened.documentId)
        XCTAssertEqual(current.text, "draft"); XCTAssertEqual(current.revision, 5)
        XCTAssertEqual(current.savedDigest, opened.savedDigest)
    }

    func testUntitledHasNoDiskDigestAndCreatesNoFiles() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.state), document = await store.create(text: "draft")
        let observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertNil(observation.diskDigest)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(observation)) as? [String: Any]
        XCTAssertEqual(Set(json?.keys.map { $0 } ?? []), ["status", "diskDigest"])
        XCTAssertTrue(json?["diskDigest"] is NSNull)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: files.root.path).isEmpty)
        let current = try await store.updateFormat(id: document.documentId, text: "draft", revision: 0, encoding: "utf8")
        XCTAssertEqual(current, document)
    }

    func testMissingThenRestoredFileIsComparedWithTheOriginalDigest() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        try FileManager.default.removeItem(at: files.file)
        let missing = try await store.observe(id: document.documentId)
        XCTAssertEqual(missing.status, .missing); XCTAssertNil(missing.diskDigest)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.file.path))
        try Data("xyz".utf8).write(to: files.file)
        let different = try await store.observe(id: document.documentId)
        XCTAssertEqual(different.status, .modified); XCTAssertEqual(different.diskDigest, xyzDigest)
        try Data("abc".utf8).write(to: files.file)
        let same = try await store.observe(id: document.documentId)
        XCTAssertEqual(same.status, .unchanged); XCTAssertEqual(same.diskDigest, abcDigest)
        let current = try await store.verifySaved(id: document.documentId)
        XCTAssertEqual(current, document)
    }

    func testUTF16EncodingChangeWithIdenticalTextIsModified() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data([0xff, 0xfe, 0x41, 0]).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        XCTAssertEqual(document.text, "A")
        let initial = try await store.observe(id: document.documentId)
        XCTAssertEqual(initial.status, .unchanged)
        XCTAssertEqual(initial.diskDigest, "53c523bad1a04b0d2fce18ee10dacb6a7362f3804cdcbdaf68ff1ae76e8a51cd")
        try Data([0xfe, 0xff, 0, 0x41]).write(to: files.file)
        let external = try await store.observe(id: document.documentId)
        XCTAssertEqual(external.status, .modified)
        XCTAssertEqual(external.diskDigest, "da8a119778b37f63a166b7754543f8e88a5a3f2a2dafa5001a4bb1126c330cf3")
        let recovery = try await store.recoveries()
        XCTAssertTrue(recovery.isEmpty)
    }

    func testInvalidExternalEncodingCanBeObservedAndFailedReloadPreservesLiveState() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        try await store.checkpoint(id: document.documentId, text: "draft 한글\r\n", revision: 4)
        let recoveryFile = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: files.state.appendingPathComponent("recoveries"), includingPropertiesForKeys: nil).first)
        let recoveryBytes = try Data(contentsOf: recoveryFile)
        let invalid = Data([0xff, 0xfe, 0, 0xd8])
        try invalid.write(to: files.file)
        let observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .modified)
        XCTAssertEqual(observation.diskDigest, "7dede2c66266f92ce35bf21a950f202c75633079eca964654959a3c611acaaa6")
        do {
            _ = try await store.reload(id: document.documentId, revision: 8)
            XCTFail("Malformed UTF-16 must remain a reload error")
        } catch { XCTAssertEqual(error as? DocumentError, .invalidEncoding(files.file.path)) }
        XCTAssertEqual(try Data(contentsOf: files.file), invalid)
        XCTAssertEqual(try Data(contentsOf: recoveryFile), recoveryBytes)
        try Data("abc".utf8).write(to: files.file)
        let current = try await store.verifySaved(id: document.documentId)
        XCTAssertEqual(current.text, "draft 한글\r\n"); XCTAssertEqual(current.revision, 4)
        XCTAssertEqual(current.encoding, "utf8"); XCTAssertEqual(current.lineEnding, "CRLF")
        XCTAssertEqual(current.savedDigest, document.savedDigest)
    }

    func testSymlinkAliasRetargetDoesNotChangeTheOwnedBinding() async throws {
        let files = try Files(); defer { files.cleanup() }
        let alias = files.root.appendingPathComponent("alias.md"), other = files.root.appendingPathComponent("other.md")
        try Data("abc".utf8).write(to: files.file); try Data("xyz".utf8).write(to: other)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: alias.path)
        XCTAssertEqual(document.path, files.file.path)
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: other)
        let observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertEqual(observation.diskDigest, abcDigest)
        try FileManager.default.removeItem(at: files.file)
        let missing = try await store.observe(id: document.documentId)
        XCTAssertEqual(missing.status, .missing); XCTAssertNil(missing.diskDigest)
        try FileManager.default.createSymbolicLink(at: files.file, withDestinationURL: other)
        do {
            _ = try await store.observe(id: document.documentId)
            XCTFail("A replacement symlink must not redirect observation outside the binding")
        } catch { XCTAssertEqual((error as? DocumentError)?.code, "io") }
        XCTAssertEqual(try Data(contentsOf: other), Data("xyz".utf8))
    }

    func testListedRecoveriesDoNotGrantObservationClaimsAndRestoreKeepsTheBaseline() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let owner = DocumentStore(dataDirectory: files.state), other = DocumentStore(dataDirectory: files.state)
        let document = try await owner.open(path: files.file.path)
        try await owner.checkpoint(id: document.documentId, text: "draft", revision: 3)
        let listed = try await other.recoveries()
        XCTAssertEqual(listed.count, 1)
        for id in ["unknown", document.documentId] {
            do { _ = try await other.observe(id: id); XCTFail("Observation must require a live owned record") }
            catch { XCTAssertEqual(error as? DocumentError, .unknownDocument(id)) }
        }
        do { _ = try await other.restore(id: document.documentId); XCTFail("Observation must not release the owner's claim") }
        catch { XCTAssertEqual(error as? DocumentError, .conflict(document.documentId)) }
        await owner.close(id: document.documentId)
        do { _ = try await owner.observe(id: document.documentId); XCTFail("Closed record must be unknown") }
        catch { XCTAssertEqual(error as? DocumentError, .unknownDocument(document.documentId)) }
        let restored = try await other.restore(id: document.documentId)
        try Data("xyz".utf8).write(to: files.file)
        let observation = try await other.observe(id: restored.documentId)
        XCTAssertEqual(observation.status, .modified); XCTAssertEqual(observation.diskDigest, xyzDigest)
        await other.closeAll()
        do { _ = try await other.observe(id: document.documentId); XCTFail("Close-all must release observation access") }
        catch { XCTAssertEqual(error as? DocumentError, .unknownDocument(document.documentId)) }
    }

    func testObservationUsesTheLatestSaveReloadAndRebindState() async throws {
        let files = try Files(); defer { files.cleanup() }
        let store = DocumentStore(dataDirectory: files.state), document = await store.create(text: "draft")
        _ = try await store.saveAs(id: document.documentId, path: files.file.path, text: "abc", revision: 1)
        var observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertEqual(observation.diskDigest, abcDigest)
        _ = try await store.save(id: document.documentId, text: "xyz", revision: 2)
        observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertEqual(observation.diskDigest, xyzDigest)
        try Data("abc".utf8).write(to: files.file)
        _ = try await store.reload(id: document.documentId, revision: 3)
        observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertEqual(observation.diskDigest, abcDigest)
        let moved = files.root.appendingPathComponent("moved.md")
        try FileManager.default.moveItem(at: files.file, to: moved)
        _ = try await store.rebind(id: document.documentId, path: moved.path)
        observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertEqual(observation.diskDigest, abcDigest)
        _ = try await store.rebind(id: document.documentId, path: nil)
        try Data("xyz".utf8).write(to: moved)
        observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .unchanged); XCTAssertNil(observation.diskDigest)
    }

    func testNonregularFilesAndENOTDIRAreErrorsRatherThanMissing() async throws {
        let files = try Files(); defer { files.cleanup() }
        let parent = files.root.appendingPathComponent("parent"), file = parent.appendingPathComponent("note.md")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false)
        try Data("abc".utf8).write(to: file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: file.path)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        do { _ = try await store.observe(id: document.documentId); XCTFail("Directory is not a missing regular file") }
        catch { XCTAssertEqual(error as? DocumentError, .invalidPath(file.path)) }
        try FileManager.default.removeItem(at: file)
        XCTAssertEqual(Darwin.mkfifo(file.path, 0o600), 0)
        do { _ = try await store.observe(id: document.documentId); XCTFail("FIFO must fail without waiting for a writer") }
        catch { XCTAssertEqual(error as? DocumentError, .invalidPath(file.path)) }
        try FileManager.default.removeItem(at: parent)
        try Data("abc".utf8).write(to: parent)
        do { _ = try await store.observe(id: document.documentId); XCTFail("ENOTDIR must not be reported as ENOENT") }
        catch { XCTAssertEqual((error as? DocumentError)?.code, "io") }
    }

    func testPermissionFailureRemainsTypedAndPreservesTheRecord() async throws {
        guard geteuid() != 0 else { throw XCTSkip("Root bypasses the unreadable-file fixture") }
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: files.file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: files.file.path) }
        do { _ = try await store.observe(id: document.documentId); XCTFail("Unreadable file must not be reported as missing") }
        catch { XCTAssertEqual((error as? DocumentError)?.code, "io") }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: files.file.path)
        let current = try await store.verifySaved(id: document.documentId)
        XCTAssertEqual(current, document)
    }

    func testLargeExternalReplacementIsHashedAcrossChunks() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        let handle = try FileHandle(forWritingTo: files.file)
        try handle.truncate(atOffset: 0)
        let chunk = Data(repeating: 0x78, count: 64 * 1024)
        for _ in 0..<512 { try handle.write(contentsOf: chunk) }
        try handle.close()
        let observation = try await store.observe(id: document.documentId)
        XCTAssertEqual(observation.status, .modified)
        XCTAssertEqual(observation.diskDigest, "05f052c8f6da8ee5228ec291820b559c4be183773b9e97a6b82e30dacff85dd3")
        let attrs = try FileManager.default.attributesOfItem(atPath: files.file.path)
        XCTAssertEqual((attrs[.size] as? NSNumber)?.intValue, 32 * 1024 * 1024)
    }

    func testCancelledStreamingDigestThrowsCancellationWithoutChangingTheFile() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let task = Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return try FileIO.diskDigest(files.file)
        }
        do { _ = try await task.value; XCTFail("Streaming observation must honor cancellation") }
        catch { XCTAssertTrue(error is CancellationError, "Cancellation must not become an IO error: \(error)") }
        XCTAssertEqual(try Data(contentsOf: files.file), Data("abc".utf8))
    }

    func testCallerBaselineAfterReloadRejectsStaleSaveAndPreservesCheckpoint() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), oldView = try await store.open(path: files.file.path)
        try Data("xyz".utf8).write(to: files.file)
        _ = try await store.reload(id: oldView.documentId, revision: 2)
        try await store.checkpoint(id: oldView.documentId, text: "old view edit", revision: 3)
        let before = try await store.verifySaved(id: oldView.documentId)
        let recoveryFile = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: files.state.appendingPathComponent("recoveries"), includingPropertiesForKeys: nil).first)
        let recoveryBytes = try Data(contentsOf: recoveryFile)
        do {
            _ = try await store.save(id: oldView.documentId, text: "old view edit", revision: 4, expectedDigest: oldView.savedDigest, enforceExpectedDigest: true)
            XCTFail("A stale frontend baseline must conflict even when the backend matches disk")
        } catch { XCTAssertEqual(error as? DocumentError, .conflict(files.file.path)) }
        XCTAssertEqual(try Data(contentsOf: files.file), Data("xyz".utf8))
        XCTAssertEqual(try Data(contentsOf: recoveryFile), recoveryBytes)
        let current = try await store.verifySaved(id: oldView.documentId)
        XCTAssertEqual(current, before)
    }

    func testCurrentCallerBaselineSavesButDoesNotBypassExternalFileConflict() async throws {
        let files = try Files(); defer { files.cleanup() }
        try Data("abc".utf8).write(to: files.file)
        let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
        try Data("xyz".utf8).write(to: files.file)
        _ = try await store.reload(id: document.documentId, revision: 2)
        let saved = try await store.save(id: document.documentId, text: "current view edit", revision: 3, expectedDigest: xyzDigest, enforceExpectedDigest: true)
        XCTAssertEqual(saved.text, "current view edit")
        XCTAssertEqual(try Data(contentsOf: files.file), Data("current view edit".utf8))
        try Data("abc".utf8).write(to: files.file)
        do {
            _ = try await store.save(id: document.documentId, text: "must not overwrite", revision: 4, expectedDigest: saved.savedDigest, enforceExpectedDigest: true)
            XCTFail("Matching caller baseline must still check actual external bytes")
        } catch { XCTAssertEqual(error as? DocumentError, .conflict(files.file.path)) }
        XCTAssertEqual(try Data(contentsOf: files.file), Data("abc".utf8))
    }

    func testNullableLegacyAndForcedExpectationsRemainDistinct() async throws {
        let cases: [(name: String, expected: String?, enforce: Bool, force: Bool, conflicts: Bool)] = [
            ("explicit null", nil, true, false, true),
            ("explicit force", abcDigest, true, true, false),
            ("legacy omission", nil, false, false, false),
            ("unenforced argument", abcDigest, false, false, false)
        ]
        for test in cases {
            let files = try Files(); defer { files.cleanup() }
            try Data("abc".utf8).write(to: files.file)
            let store = DocumentStore(dataDirectory: files.state), document = try await store.open(path: files.file.path)
            try Data("xyz".utf8).write(to: files.file)
            _ = try await store.reload(id: document.documentId, revision: 2)
            do {
                let saved = try await store.save(id: document.documentId, text: "explicit save", revision: 3, force: test.force, expectedDigest: test.expected, enforceExpectedDigest: test.enforce)
                XCTAssertFalse(test.conflicts, test.name)
                XCTAssertEqual(saved.text, "explicit save", test.name)
                XCTAssertEqual(try Data(contentsOf: files.file), Data("explicit save".utf8), test.name)
            } catch {
                XCTAssertTrue(test.conflicts, test.name)
                XCTAssertEqual(error as? DocumentError, .conflict(files.file.path), test.name)
                XCTAssertEqual(try Data(contentsOf: files.file), Data("xyz".utf8), test.name)
            }
        }
    }
}
