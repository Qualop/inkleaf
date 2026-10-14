import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class DocumentObservationBridgeTests: XCTestCase {
    private let abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    private let xyzDigest = "3608bca1e44ea6c4d268eb6db02260269892c0b42b86bbf1e77a6fa16c3c9282"

    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriObservationBridge-\(UUID().uuidString)").resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func bridge(at root: URL, sessions: WindowSessionStore? = nil, id: String = UUID().uuidString) throws -> Bridge {
        _ = NSApplication.shared
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", root.path, "--data-dir", root.appendingPathComponent("state").path])
        return Bridge(webView: WKWebView(), options: options, windowSessions: sessions, windowID: id)
    }

    private func request(_ method: String, _ args: [String: Any]) throws -> NativeRequest {
        try NativeRequest.parse(["id": 17, "method": method, "args": args])
    }

    private func snapshot(_ value: JSONValue) throws -> DocumentSnapshot {
        try JSONDecoder().decode(DocumentSnapshot.self, from: JSONEncoder().encode(value))
    }

    private func observe(_ bridge: Bridge, _ id: String) async throws -> JSONValue {
        try await bridge.dispatch(request("observeDocument", ["documentId": id]))
    }

    private func expected(_ status: String, _ digest: String? = nil) -> JSONValue {
        .object(["status": .string(status), "diskDigest": digest.map(JSONValue.string) ?? .null])
    }

    private func failureCode(_ bridge: Bridge, _ request: NativeRequest) async -> String? {
        do {
            _ = try await bridge.dispatch(request)
            XCTFail("Expected a typed failure for \(request.method)")
            return nil
        } catch {
            guard case .object(let reply) = NativeReply.failure(id: request.id, error: error).value,
                  case .object(let failure) = reply["error"], case .string(let code) = failure["code"] else {
                XCTFail("Missing typed error envelope")
                return nil
            }
            return code
        }
    }

    func testExternalBytesAreObservedWithoutAdvancingTheSaveBaseline() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let bridge = try bridge(at: root)
        let opened = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
        let initial = try await observe(bridge, opened.documentId)
        XCTAssertEqual(initial, expected("unchanged", abcDigest))
        try Data("abc".utf8).write(to: file, options: .atomic)
        let same = try await observe(bridge, opened.documentId)
        XCTAssertEqual(same, initial)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        try Data("xyz".utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: attributes[.modificationDate]!], ofItemAtPath: file.path)
        for _ in 0..<2 {
            let result = try await observe(bridge, opened.documentId)
            XCTAssertEqual(result, expected("modified", xyzDigest))
        }
        let code = await failureCode(bridge, try request("saveDocument", ["documentId": opened.documentId, "text": "draft", "revision": 1]))
        XCTAssertEqual(code, "conflict")
        XCTAssertEqual(try Data(contentsOf: file), Data("xyz".utf8))
        let reloaded = try snapshot(await bridge.dispatch(request("reloadDocument", ["documentId": opened.documentId, "revision": 1])))
        XCTAssertEqual(reloaded.text, "xyz")
        let afterReload = try await observe(bridge, opened.documentId)
        XCTAssertEqual(afterReload, expected("unchanged", xyzDigest))
    }

    func testUntitledReturnsExplicitNullAndIgnoresAnUnboundPath() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root)
        let document = try snapshot(await bridge.dispatch(request("createDocument", ["text": "draft"])))
        let unbound = root.appendingPathComponent("unbound.md")
        try Data("xyz".utf8).write(to: unbound)
        let before = try FileManager.default.contentsOfDirectory(atPath: root.path)
        let result = try await bridge.dispatch(request("observeDocument", ["documentId": document.documentId, "path": unbound.path, "text": "overwrite", "revision": 99, "force": true]))
        XCTAssertEqual(result, expected("unchanged"))
        XCTAssertEqual(try Data(contentsOf: unbound), Data("xyz".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), before)
        let recovery = try await bridge.documents.recoveries()
        XCTAssertTrue(recovery.isEmpty)
        let current = try await bridge.documents.updateFormat(id: document.documentId, text: "draft", revision: 0, encoding: "utf8")
        XCTAssertEqual(current, document)
    }

    func testUTF16AndInvalidReplacementBytesPreserveDraftAndRecovery() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root), file = root.appendingPathComponent("encoding.md")
        let original = Data([0xff, 0xfe, 0x41, 0])
        try original.write(to: file)
        let opened = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
        _ = try await bridge.dispatch(request("checkpoint", ["documentId": opened.documentId, "text": "local 한글\r\n", "revision": 7]))
        let recoveryFile = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("state/recoveries"), includingPropertiesForKeys: nil).first)
        let recoveryBytes = try Data(contentsOf: recoveryFile)
        let initial = try await observe(bridge, opened.documentId)
        XCTAssertEqual(initial, expected("unchanged", "53c523bad1a04b0d2fce18ee10dacb6a7362f3804cdcbdaf68ff1ae76e8a51cd"))
        try Data([0xfe, 0xff, 0, 0x41]).write(to: file)
        let sameTextDifferentEncoding = try await observe(bridge, opened.documentId)
        XCTAssertEqual(sameTextDifferentEncoding, expected("modified", "da8a119778b37f63a166b7754543f8e88a5a3f2a2dafa5001a4bb1126c330cf3"))
        let invalid = Data([0xff, 0xfe, 0, 0xd8])
        try invalid.write(to: file)
        let invalidObservation = try await observe(bridge, opened.documentId)
        XCTAssertEqual(invalidObservation, expected("modified", "7dede2c66266f92ce35bf21a950f202c75633079eca964654959a3c611acaaa6"))
        let code = await failureCode(bridge, try request("reloadDocument", ["documentId": opened.documentId, "revision": 8]))
        XCTAssertEqual(code, "invalidEncoding")
        XCTAssertEqual(try Data(contentsOf: recoveryFile), recoveryBytes)
        try original.write(to: file)
        let current = try await bridge.documents.verifySaved(id: opened.documentId)
        XCTAssertEqual(current.text, "local 한글\r\n")
        XCTAssertEqual(current.revision, 7)
        XCTAssertEqual(current.encoding, "utf16le")
        XCTAssertEqual(current.savedDigest, opened.savedDigest)
    }

    func testObservationKeepsTheCanonicalSymlinkBinding() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("original.md"), other = root.appendingPathComponent("other.md"), alias = root.appendingPathComponent("alias.md")
        try Data("abc".utf8).write(to: file); try Data("xyz".utf8).write(to: other)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: file)
        let bridge = try bridge(at: root)
        let document = try snapshot(await bridge.dispatch(request("openDocument", ["path": alias.path])))
        XCTAssertEqual(document.path, file.path)
        try FileManager.default.removeItem(at: alias)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: other)
        let result = try await observe(bridge, document.documentId)
        XCTAssertEqual(result, expected("unchanged", abcDigest))
        try Data("xyz".utf8).write(to: file)
        let modified = try await observe(bridge, document.documentId)
        XCTAssertEqual(modified, expected("modified", xyzDigest))
        XCTAssertEqual(try Data(contentsOf: other), Data("xyz".utf8))
    }

    func testMissingRestoredAndNonregularPathsHaveDistinctResults() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let bridge = try bridge(at: root), document = try await bridge.documents.open(path: file.path)
        try FileManager.default.removeItem(at: file)
        let missing = try await observe(bridge, document.documentId)
        XCTAssertEqual(missing, expected("missing"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        try Data("abc".utf8).write(to: file)
        let restored = try await observe(bridge, document.documentId)
        XCTAssertEqual(restored, expected("unchanged", abcDigest))
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let code = await failureCode(bridge, try request("observeDocument", ["documentId": document.documentId]))
        XCTAssertEqual(code, "invalidPath")
    }

    func testOnlyClaimedDocumentsCanBeObservedAndClosedClaimsAreRejected() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let owner = try bridge(at: root), other = try bridge(at: root)
        let document = try await owner.documents.open(path: file.path)
        try await owner.documents.checkpoint(id: document.documentId, text: "draft", revision: 2)
        for id in ["unknown", document.documentId] {
            let code = await failureCode(other, try request("observeDocument", ["documentId": id, "path": file.path]))
            XCTAssertEqual(code, "unknownDocument")
        }
        _ = try await other.dispatch(request("bootstrap", [:]))
        let listedCode = await failureCode(other, try request("observeDocument", ["documentId": document.documentId]))
        XCTAssertEqual(listedCode, "unknownDocument")
        _ = try await owner.dispatch(request("closeDocument", ["documentId": document.documentId]))
        let closedCode = await failureCode(owner, try request("observeDocument", ["documentId": document.documentId]))
        XCTAssertEqual(closedCode, "unknownDocument")
        let restored = try snapshot(await other.dispatch(request("restoreDocument", ["documentId": document.documentId])))
        XCTAssertEqual(restored.text, "draft")
        try Data("xyz".utf8).write(to: file)
        let observation = try await observe(other, restored.documentId)
        XCTAssertEqual(observation, expected("modified", xyzDigest))
    }

    func testInvalidArgumentsAndClosedBridgeReturnTypedErrors() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root), document = await bridge.documents.create()
        let argumentSets: [[String: Any]] = [[:], ["documentId": NSNull()], ["documentId": 1]]
        for args in argumentSets {
            let code = await failureCode(bridge, try request("observeDocument", args))
            XCTAssertEqual(code, "invalidRequest")
        }
        try await bridge.removeWindowSession()
        let closedCode = await failureCode(bridge, try request("observeDocument", ["documentId": document.documentId]))
        XCTAssertEqual(closedCode, "cancelled")
        let unknownCode = await failureCode(bridge, try request("observeDocument", ["documentId": "unknown"]))
        XCTAssertEqual(unknownCode, "cancelled")
    }

    func testWindowCloseDrainsAcceptedObservationBeforeReleasingRecords() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let sessions = WindowSessionStore(dataDirectory: root.appendingPathComponent("state"))
        for round in 0..<6 {
            let id = "observation-\(round)", bridge = try bridge(at: root, sessions: sessions, id: id)
            try await sessions.update(id: id, values: [:], frame: nil)
            let file = root.appendingPathComponent("note-\(round).md")
            try Data("abc".utf8).write(to: file)
            let documents = bridge.documents, document = try await documents.open(path: file.path)
            try await documents.checkpoint(id: document.documentId, text: "draft", revision: 3)
            let gate = ObservationExecutorGate()
            defer { gate.release() }
            let blocked = Task.detached { await documents.holdObservationExecutor(gate) }
            for _ in 0..<200 where !gate.isBlocked { try await Task.sleep(for: .milliseconds(1)) }
            XCTAssertTrue(gate.isBlocked, "Fixture must occupy the real document actor")
            var accepted = false
            let observationRequest = try request("observeDocument", ["documentId": document.documentId])
            let observation = Task(priority: .background) { @MainActor in
                accepted = true
                do { return Result<JSONValue, any Error>.success(try await bridge.dispatch(observationRequest)) }
                catch { return .failure(error) }
            }
            while !accepted { await Task.yield() }
            // Allow the accepted operation to reach the occupied document executor.
            try await Task.sleep(for: .milliseconds(20))
            let closing = Task(priority: .userInitiated) { @MainActor in try await bridge.removeWindowSession() }
            for _ in 0..<200 {
                if try await sessions.all().allSatisfy({ $0.id != id }) { break }
                try await Task.sleep(for: .milliseconds(1))
            }
            let lateCode = await failureCode(bridge, observationRequest)
            XCTAssertEqual(lateCode, "cancelled", "Closing must reject newly submitted observations")
            gate.release()
            await blocked.value
            let result = await observation.value
            try await closing.value
            switch result {
            case .success(let value): XCTAssertEqual(value, expected("unchanged", abcDigest))
            case .failure(let error):
                XCTAssertTrue(error is CancellationError, "Accepted observation raced released records: \(error)")
            }
            do { _ = try await documents.verifySaved(id: document.documentId); XCTFail("Close must release the live record") }
            catch { XCTAssertEqual(error as? DocumentError, .unknownDocument(document.documentId)) }
            let restored = try await DocumentStore(dataDirectory: root.appendingPathComponent("state")).restore(id: document.documentId)
            XCTAssertEqual(restored.text, "draft"); XCTAssertEqual(restored.revision, 3)
            XCTAssertEqual(try Data(contentsOf: file), Data("abc".utf8))
        }
    }

    func testStaleCallerDigestAfterNativeReloadCannotOverwriteUnseenBytes() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root), file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let oldView = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
        try Data("xyz".utf8).write(to: file)
        let nativeReload = try snapshot(await bridge.dispatch(request("reloadDocument", ["documentId": oldView.documentId, "revision": 2])))
        XCTAssertEqual(nativeReload.savedDigest, xyzDigest)
        let staleSave = try request("saveDocument", ["documentId": oldView.documentId, "text": "old view edit", "revision": 3, "expectedDigest": try XCTUnwrap(oldView.savedDigest)])
        let code = await failureCode(bridge, staleSave)
        XCTAssertEqual(code, "conflict")
        XCTAssertEqual(try Data(contentsOf: file), Data("xyz".utf8))
        let current = try await bridge.documents.verifySaved(id: oldView.documentId)
        XCTAssertEqual(current, nativeReload)
        let observation = try await observe(bridge, oldView.documentId)
        XCTAssertEqual(observation, expected("unchanged", xyzDigest))
    }

    func testCurrentCallerDigestSavesAndStillChecksExternalBytesAtCommit() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root), file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let document = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
        try Data("xyz".utf8).write(to: file)
        _ = try await bridge.dispatch(request("reloadDocument", ["documentId": document.documentId, "revision": 2]))
        let saved = try snapshot(await bridge.dispatch(request("saveDocument", ["documentId": document.documentId, "text": "current view edit", "revision": 3, "expectedDigest": xyzDigest])))
        XCTAssertEqual(saved.text, "current view edit"); XCTAssertEqual(saved.revision, 3)
        XCTAssertEqual(try Data(contentsOf: file), Data("current view edit".utf8))
        try Data("abc".utf8).write(to: file)
        let code = await failureCode(bridge, try request("saveDocument", ["documentId": document.documentId, "text": "must not overwrite", "revision": 4, "expectedDigest": try XCTUnwrap(saved.savedDigest)]))
        XCTAssertEqual(code, "conflict")
        XCTAssertEqual(try Data(contentsOf: file), Data("abc".utf8))
    }

    func testExplicitForceAndLegacyOmissionCanSaveAfterNativeReload() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root)
        for (name, extra) in [("forced", ["expectedDigest": abcDigest, "force": true] as [String: Any]), ("legacy", [:])] {
            let file = root.appendingPathComponent("\(name).md")
            try Data("abc".utf8).write(to: file)
            let document = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
            try Data("xyz".utf8).write(to: file)
            _ = try await bridge.dispatch(request("reloadDocument", ["documentId": document.documentId, "revision": 2]))
            var args: [String: Any] = ["documentId": document.documentId, "text": "explicit save", "revision": 3]
            args.merge(extra) { _, new in new }
            let saved = try snapshot(await bridge.dispatch(request("saveDocument", args)))
            XCTAssertEqual(saved.text, "explicit save")
            XCTAssertEqual(try Data(contentsOf: file), Data("explicit save".utf8))
        }
    }

    func testNullCallerDigestIsEnforcedAndMalformedDigestIsRejected() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try bridge(at: root), file = root.appendingPathComponent("note.md")
        try Data("abc".utf8).write(to: file)
        let document = try snapshot(await bridge.dispatch(request("openDocument", ["path": file.path])))
        let expectations: [Any] = [NSNull(), 42, true, ["digest"], ["digest": "wrong"]]
        for digest in expectations {
            let args: [String: Any] = ["documentId": document.documentId, "text": "must not save", "revision": 1, "expectedDigest": digest]
            let code = await failureCode(bridge, try request("saveDocument", args))
            XCTAssertEqual(code, digest is NSNull ? "conflict" : "invalidRequest")
            XCTAssertEqual(try Data(contentsOf: file), Data("abc".utf8))
        }
        let saved = try snapshot(await bridge.dispatch(request("saveAs", ["documentId": document.documentId, "text": "new destination", "revision": 1, "path": root.appendingPathComponent("other.md").path])))
        XCTAssertEqual(saved.text, "new destination")
    }
}

private final class ObservationExecutorGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var blocked = false
    private var released = false
    var isBlocked: Bool {
        condition.lock(); defer { condition.unlock() }
        return blocked
    }
    func hold() {
        condition.lock(); defer { condition.unlock() }
        blocked = true
        let deadline = Date().addingTimeInterval(5)
        while !released { if !condition.wait(until: deadline) { break } }
    }
    func release() {
        condition.lock(); defer { condition.unlock() }
        released = true; condition.broadcast()
    }
}

private extension DocumentStore {
    func holdObservationExecutor(_ gate: ObservationExecutorGate) { gate.hold() }
}
