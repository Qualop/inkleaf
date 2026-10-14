import Foundation
import XCTest
@testable import DocumentCore

final class AssetSaveTests: XCTestCase, @unchecked Sendable {
    func testFirstSavePublishesOnlyReferencedImagesAndRewritesCollisions() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriAssetTest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let old = root.appendingPathComponent("unsaved"), target = root.appendingPathComponent("published"), data = root.appendingPathComponent("state")
        try FileManager.default.createDirectory(at: old.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let image = old.appendingPathComponent("assets/a b.png"), collision = target.appendingPathComponent("assets/a b.png")
        try Data([1,2,3]).write(to:image); try Data([9]).write(to:collision)
        try Data([4]).write(to:old.appendingPathComponent("assets/unreferenced.png"))
        let text = "![한글](assets/a%20b.png)\r\n`![code](assets/a%20b.png)`\r\n<img src=\"assets/a%20b.png\" width=\"20\">"
        let ns = text as NSString, first = ns.range(of:"assets/a%20b.png"), last = ns.range(of:"assets/a%20b.png",options:.backwards)
        let refs = [DocumentAssetReference(path:image.path,from:first.location,to:NSMaxRange(first)), DocumentAssetReference(path:image.path,from:last.location,to:NSMaxRange(last),html:true)]
        let store = DocumentStore(dataDirectory:data), doc = await store.create(text:text), destination = target.appendingPathComponent("note.md")
        let saved = try await store.saveAs(id:doc.documentId,path:destination.path,text:text,revision:1,assetRoot:old.path,imageReferences:refs)
        XCTAssertEqual(saved.text,"![한글](assets/a%20b-1.png)\r\n`![code](assets/a%20b.png)`\r\n<img src=\"assets/a%20b-1.png\" width=\"20\">")
        XCTAssertEqual(try String(contentsOf:destination,encoding:.utf8),saved.text)
        XCTAssertEqual(try Data(contentsOf:target.appendingPathComponent("assets/a b-1.png")),Data([1,2,3]))
        XCTAssertEqual(try Data(contentsOf:collision),Data([9])); XCTAssertTrue(FileManager.default.fileExists(atPath:image.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath:target.appendingPathComponent("assets/unreferenced.png").path))
        let reopened = try await store.open(path:destination.path); XCTAssertEqual(reopened.text,saved.text)
    }
    func testFailedSaveRollsBackPublishedCopiesAndPreservesOriginals() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("MoriAssetTest-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at:root) }
        let old=root.appendingPathComponent("old"),target=root.appendingPathComponent("target")
        try FileManager.default.createDirectory(at:old,withIntermediateDirectories:true);try FileManager.default.createDirectory(at:target,withIntermediateDirectories:true)
        let image=old.appendingPathComponent("p.png"),dest=target.appendingPathComponent("existing.md")
        try Data([1]).write(to:image);try Data("original".utf8).write(to:dest)
        let text="![](p.png)",store=DocumentStore(dataDirectory:root.appendingPathComponent("state")),doc=await store.create(text:text)
        do { _ = try await store.saveAs(id:doc.documentId,path:dest.path,text:text,revision:1,assetRoot:old.path,imageReferences:[DocumentAssetReference(path:image.path,from:4,to:9)]);XCTFail("Expected destination conflict") } catch { XCTAssertEqual(error as? DocumentError,.conflict(dest.path)) }
        XCTAssertEqual(try String(contentsOf:dest,encoding:.utf8),"original");XCTAssertTrue(FileManager.default.fileExists(atPath:image.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath:target.appendingPathComponent("assets/p.png").path))
    }
    func testReloadRetainsIdentityUsesMonotonicRevisionAndChecksSubsequentDiskChanges() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriReloadTest-\(UUID().uuidString)")
        defer {try? FileManager.default.removeItem(at:root)}
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let path=root.appendingPathComponent("a.md");try Data("old".utf8).write(to:path)
        let store=DocumentStore(dataDirectory:root.appendingPathComponent("state")),doc=try await store.open(path:path.path)
        try await store.checkpoint(id:doc.documentId,text:"edits",revision:1);try Data("disk".utf8).write(to:path)
        let reloaded=try await store.reload(id:doc.documentId,revision:2)
        XCTAssertEqual(reloaded.documentId,doc.documentId);XCTAssertEqual(reloaded.text,"disk");XCTAssertEqual(reloaded.revision,2)
        let recoveries = try await store.recoveries(); XCTAssertTrue(recoveries.isEmpty)
        try Data("new external change".utf8).write(to:path)
        do {_ = try await store.save(id:doc.documentId,text:"edits",revision:3);XCTFail("Must observe new base digest")}catch{XCTAssertEqual(error as? DocumentError,.conflict(path.path))}
    }
    func testFileBindingTracksRealNativeMoveAndRejectsExternalChanges() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriBindingTest-\(UUID().uuidString)")
        defer {try? FileManager.default.removeItem(at:root)}
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        let path=root.appendingPathComponent("old.md"),destination=root.appendingPathComponent("new.md")
        try Data("saved".utf8).write(to:path)
        let store=DocumentStore(dataDirectory:root.appendingPathComponent("state")),workspace=WorkspaceStore(dataDirectory:root)
        let doc=try await store.open(path:path.path)
        _ = try await workspace.manage(operation:"rename",path:path.path,destination:destination.path)
        let rebound=try await store.rebind(id:doc.documentId,path:destination.path)
        XCTAssertEqual(rebound.documentId,doc.documentId);XCTAssertEqual(rebound.path,destination.path)
        _ = try await store.save(id:doc.documentId,text:"changed",revision:1)
        XCTAssertEqual(try String(contentsOf:destination,encoding:.utf8),"changed")
        XCTAssertFalse(FileManager.default.fileExists(atPath:path.path))
        try Data("external".utf8).write(to:destination)
        do {_ = try await store.verifySaved(id:doc.documentId);XCTFail("Must reject changed disk source")}catch{XCTAssertEqual(error as? DocumentError,.conflict(destination.path))}
    }

}
