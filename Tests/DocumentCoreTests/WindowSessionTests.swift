import XCTest
@testable import DocumentCore

@MainActor final class WindowSessionTests:XCTestCase{
    func testDraftIdentitiesOrderActiveAndCursorsSurviveRoundTrip()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriDraftSession-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let values:[String:JSONValue]=["documents":.array([.object(["documentId":.string("draft"),"path":.null]),.object(["documentId":.string("bound"),"path":.string("/saved.md")])]),"activeDocumentId":.string("draft"),"draftRevisions":.object(["draft":.number(4)]),"views":.object(["draft":.object(["anchor":.number(2),"head":.number(5),"scroll":.number(77)])])]
        let store=WindowSessionStore(dataDirectory:root);try await store.update(id:"A",values:values,frame:nil)
        let restored=try await WindowSessionStore(dataDirectory:root).all()
        XCTAssertEqual(restored.first?.content.documents?.map(\.documentId),["draft","bound"])
        XCTAssertEqual(restored.first?.content.activeDocumentId,"draft");XCTAssertEqual(restored.first?.content.views["draft"],values["views"].flatMap{if case .object(let views)=$0{return views["draft"]};return nil})
        XCTAssertEqual(restored.first?.content.draftRevisions,["draft":4])
        do {try await store.update(id:"A",values:["documents":.array([.object(["documentId":.string(""),"path":.null])])],frame:nil);XCTFail("Invalid draft identity accepted")}catch{}
        let unchanged=try await store.all();XCTAssertEqual(unchanged,restored)
    }
    func testWindowsKeepSeparateTabsAndGeometryAcrossRestart()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriWindows-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let store=WindowSessionStore(dataDirectory:root)
        try await store.update(id:"A",values:["paths":.array([.string("/a.md")]),"activePath":.string("/a.md"),"workspace":.string("/project-a"),"views":.object(["/a.md":.object(["anchor":.number(3),"head":.number(8),"scroll":.number(120)])])],frame:WindowFrame(x:10,y:20,width:900,height:650))
        try await store.update(id:"B",values:["paths":.array([.string("/b.md")]),"activePath":.string("/b.md"),"workspace":.null],frame:WindowFrame(x:30,y:40,width:1000,height:700))
        try await store.focus(id:"A")
        let restored=try await WindowSessionStore(dataDirectory:root).all()
        XCTAssertEqual(restored.map(\.id),["B","A"]);XCTAssertEqual(restored[0].content.paths,["/b.md"]);XCTAssertEqual(restored[1].frame?.x,10);XCTAssertEqual(restored[1].content.views["/a.md"],.object(["anchor":.number(3),"head":.number(8),"scroll":.number(120)]))
        try await store.remove(id:"A");let remaining=try await store.all();XCTAssertEqual(remaining.map(\.id),["B"])
        try await store.updateFrame(id:"A",frame:WindowFrame(x:0,y:0,width:900,height:650));let afterLateFrame=try await store.all();XCTAssertEqual(afterLateFrame.map(\.id),["B"])
    }
    func testInvalidSessionCannotReplacePersistedWindows()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriWindowsInvalid-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)};let store=WindowSessionStore(dataDirectory:root)
        try await store.update(id:"A",values:["paths":.array([.string("/safe.md")])],frame:nil)
        do{try await store.update(id:"A",values:["paths":.array([.string("../bad.md")])],frame:nil);XCTFail("Invalid relative path accepted")}catch{}
        let records=try await store.all();XCTAssertEqual(records[0].content.paths,["/safe.md"])
    }
    func testFocusBeforeBootstrapIsNotLostWhenBackgroundWindowFinishesLater()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriFocus-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root)}
        let store=WindowSessionStore(dataDirectory:root);try await store.focus(id:"B")
        try await store.update(id:"B",values:[:],frame:nil);try await store.update(id:"A",values:[:],frame:nil)
        let result=try await store.all();XCTAssertEqual(result.map(\.id),["A","B"])
    }
}
