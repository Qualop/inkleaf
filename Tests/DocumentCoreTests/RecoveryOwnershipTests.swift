import Foundation
import XCTest
@testable import DocumentCore

final class RecoveryOwnershipTests: XCTestCase, @unchecked Sendable {
    func testConcurrentRestoreClaimsOnlyOneStoreAndPreservesRecoveryBytes() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriRestoreRace-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let initial=DocumentStore(dataDirectory:root),document=await initial.create()
        try await initial.checkpoint(id:document.documentId,text:"복구\r\n",revision:2)
        await initial.close(id:document.documentId)
        let file=try XCTUnwrap(FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil).first)
        let before=try Data(contentsOf:file)
        let a=DocumentStore(dataDirectory:root),b=DocumentStore(dataDirectory:root)
        async let resultA=restoreResult(a,id:document.documentId)
        async let resultB=restoreResult(b,id:document.documentId)
        let results=await [resultA,resultB]
        XCTAssertEqual(results.compactMap {try? $0.get()}.count,1)
        for result in results {if case .failure(let error)=result {XCTAssertEqual(error as? DocumentError,.conflict(document.documentId))}}
        XCTAssertEqual(try Data(contentsOf:file),before)
    }

    func testStoreDeallocationReleasesRecoveryForAnotherWindow() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriRestoreLifetime-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        var owner:DocumentStore?=DocumentStore(dataDirectory:root)
        let document=await owner!.create()
        try await owner!.checkpoint(id:document.documentId,text:"owner closed 👋",revision:3)
        let next=DocumentStore(dataDirectory:root)
        do {_ = try await next.restore(id:document.documentId);XCTFail("Recovery is still owned by the original store")}
        catch {XCTAssertEqual(error as? DocumentError,.conflict(document.documentId))}
        owner=nil
        let restored=try await next.restore(id:document.documentId)
        XCTAssertEqual(restored.text,"owner closed 👋");XCTAssertEqual(restored.revision,3)
    }

    private func restoreResult(_ store:DocumentStore,id:String)async->Result<DocumentSnapshot,any Error> {
        do {return .success(try await store.restore(id:id))}catch{return .failure(error)}
    }

    func testCloseAllReleasesEveryClaimAndPreservesRecoveryFiles() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriCloseAll-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let owner=DocumentStore(dataDirectory:root),next=DocumentStore(dataDirectory:root)
        let a=await owner.create(),b=await owner.create()
        try await owner.checkpoint(id:a.documentId,text:"A 한글\r\n",revision:2)
        try await owner.checkpoint(id:b.documentId,text:"B 👋",revision:4)
        let files=try FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil)
        let before=try Dictionary(uniqueKeysWithValues:files.map {($0,try Data(contentsOf:$0))})
        await owner.closeAll()
        for (file,bytes) in before {XCTAssertEqual(try Data(contentsOf:file),bytes)}
        let restoredA=try await next.restore(id:a.documentId),restoredB=try await next.restore(id:b.documentId)
        XCTAssertEqual(restoredA.text,"A 한글\r\n");XCTAssertEqual(restoredB.text,"B 👋")
        do {try await owner.checkpoint(id:a.documentId,text:"late",revision:5);XCTFail("Closed records must be unavailable")}
        catch {XCTAssertEqual(error as? DocumentError,.unknownDocument(a.documentId))}
        await owner.closeAll()
        do {_ = try await owner.restore(id:a.documentId);XCTFail("Repeated closeAll must not release another store's claim")}
        catch {XCTAssertEqual(error as? DocumentError,.conflict(a.documentId))}
        for (file,bytes) in before {XCTAssertEqual(try Data(contentsOf:file),bytes)}
    }
}
