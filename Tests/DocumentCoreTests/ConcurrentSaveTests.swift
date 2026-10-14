import Foundation
import XCTest
@testable import DocumentCore

final class ConcurrentSaveTests: XCTestCase, @unchecked Sendable {
    func testDigestValidationAndReplacementAreOneCommitAcrossWriters() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriCommit-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("shared.md")
        let base = Data("base".utf8)
        try base.write(to: path)
        let validated = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let contenderValidated = DispatchSemaphore(value: 0)
        let first = Task.detached { () -> Bool in
            do {
                try FileIO.write(Data("first".utf8), to: path, beforeCommit: {
                    guard try FileIO.read(path) == base else { throw DocumentError.conflict(path.path) }
                    validated.signal()
                    guard release.wait(timeout: .now() + 5) == .success else { throw DocumentError.io("Test writer was not released") }
                })
                return true
            } catch { return false }
        }
        XCTAssertEqual(validated.wait(timeout: .now() + 5), .success)
        let second = Task.detached { () -> Bool in
            do {
                try FileIO.write(Data("second".utf8), to: path, beforeCommit: {
                    guard try FileIO.read(path) == base else { throw DocumentError.conflict(path.path) }
                    contenderValidated.signal()
                })
                return true
            } catch {
                XCTAssertEqual(error as? DocumentError, .conflict(path.path))
                return false
            }
        }
        // The contender must not validate while the first writer owns its checked commit.
        let overlappingValidation = wasSignalled(contenderValidated)
        release.signal()
        let results = await (first.value, second.value)
        XCTAssertFalse(overlappingValidation)
        XCTAssertTrue(results.0)
        XCTAssertFalse(results.1)
        XCTAssertEqual(try Data(contentsOf: path), Data("first".utf8))
    }

    private func wasSignalled(_ semaphore: DispatchSemaphore) -> Bool {
        semaphore.wait(timeout: .now() + 0.2) == .success
    }

    func testIndependentWindowStoresCannotBothSaveTheSameBase() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriConcurrent-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let a = DocumentStore(dataDirectory: root.appendingPathComponent("state"))
        let b = DocumentStore(dataDirectory: root.appendingPathComponent("state"))
        let base = String(repeating: "base 한글\r\n", count: 100_000)
        for round in 0..<12 {
            let path = root.appendingPathComponent("shared-\(round).md")
            try Data(base.utf8).write(to: path)
            let openedA = try await a.open(path: path.path), openedB = try await b.open(path: path.path)
            let textA = "A \(round)\r\n" + base, textB = "B \(round)\r\n" + base
            try await a.checkpoint(id: openedA.documentId, text: textA, revision: 1)
            try await b.checkpoint(id: openedB.documentId, text: textB, revision: 1)
            async let savedA = attempt(a, id: openedA.documentId, text: textA, path: path.path)
            async let savedB = attempt(b, id: openedB.documentId, text: textB, path: path.path)
            let results = await (savedA, savedB)
            XCTAssertNotEqual(results.0, results.1, "Exactly one owning window must save in round \(round)")
            let persisted = try Data(contentsOf: path)
            XCTAssertEqual(persisted, Data((results.0 ? textA : textB).utf8))
            let recoveries = try await DocumentStore(dataDirectory: root.appendingPathComponent("state")).recoveries()
            let loser = results.0 ? openedB.documentId : openedA.documentId
            XCTAssertEqual(recoveries.first(where: { $0.documentId == loser })?.text, results.0 ? textB : textA)
        }
    }

    private func attempt(_ store: DocumentStore, id: String, text: String, path: String) async -> Bool {
        do {
            _ = try await store.save(id: id, text: text, revision: 1)
            return true
        } catch {
            XCTAssertEqual(error as? DocumentError, .conflict(path))
            return false
        }
    }
}
