import XCTest
@testable import DocumentCore

@MainActor final class WorkspaceWordTests:XCTestCase{
    func testWholeWordFolderSearchMatchesUnicodeWordsWithoutTheirPrefixes()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriWord-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:root)}
        try Data("한글 한글문서 한글\ncat category cat_1 cat\n".utf8).write(to:root.appendingPathComponent("words.md"))
        let workspace=WorkspaceStore(dataDirectory:root)
        let korean=try await workspace.search(path:root.path,query:"한글",wholeWord:true)
        XCTAssertEqual(korean.map(\.from),[0,8])
        let latin=try await workspace.search(path:root.path,query:"cat",wholeWord:true)
        XCTAssertEqual(latin.map(\.from),[0,19])
    }
}
