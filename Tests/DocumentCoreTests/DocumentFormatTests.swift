import XCTest
@testable import DocumentCore

@MainActor
final class DocumentFormatTests:XCTestCase{
    func testEncodingChangeDoesNotOverwriteUntilExplicitSaveAndKeepsExternalDigestGuard()async throws{
        let dir=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString);try FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:dir)}
        let file=dir.appendingPathComponent("note.md");try Data("한글\n".utf8).write(to:file)
        let store=DocumentStore(dataDirectory:dir);let doc=try await store.open(path:file.path)
        let changed=try await store.updateFormat(id:doc.documentId,text:doc.text,revision:1,encoding:"utf16le")
        XCTAssertEqual(changed.encoding,"utf16le");XCTAssertEqual(try Data(contentsOf:file),Data("한글\n".utf8))
        _=try await store.save(id:doc.documentId,text:doc.text,revision:1)
        let bytes=try Data(contentsOf:file);XCTAssertEqual(Array(bytes.prefix(2)),[0xff,0xfe])
        let restored=try await store.open(path:file.path);XCTAssertEqual(restored.text,"한글\n")
    }
    func testUnsupportedEncodingDoesNotMutateTheOpenRecord()async throws{
        let store=DocumentStore(dataDirectory:FileManager.default.temporaryDirectory);let doc=await store.create(text:"sample")
        do{_=try await store.updateFormat(id:doc.documentId,text:doc.text,revision:1,encoding:"madeup");XCTFail("Expected format error")}catch{XCTAssertTrue(error is DocumentError)}
    }
}
