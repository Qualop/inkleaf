import XCTest
import WebKit
import DocumentCore
@testable import Mori

@MainActor final class SessionRestorationTests:XCTestCase {
    private func call(_ bridge:Bridge,_ method:String,_ args:[String:JSONValue]=[:])async throws->JSONValue {
        try await bridge.dispatch(NativeRequest(id:1,method:method,args:args))
    }
    private func snapshot(_ value:JSONValue)throws->DocumentSnapshot {
        try JSONDecoder().decode(DocumentSnapshot.self,from:JSONEncoder().encode(value))
    }
    func testDraftAndBoundRecoveryRestoreLatestTextAndOriginalDigest()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriSession-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        let file=root.appendingPathComponent("saved.md");try Data("base".utf8).write(to:file)
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path])
        let first=Bridge(webView:WKWebView(),options:options)
        let draft=try snapshot(await call(first,"createDocument")),bound=try snapshot(await call(first,"openDocument",["path":.string(file.path)]))
        _=try await call(first,"checkpoint",["documentId":.string(draft.documentId),"text":.string("새 초안 👋"),"revision":.number(4)])
        _=try await call(first,"checkpoint",["documentId":.string(bound.documentId),"text":.string("최신 수정"),"revision":.number(7)])
        let kept=try snapshot(await call(first,"keepRecovery",["documentId":.string(bound.documentId),"revision":.number(7)]));XCTAssertEqual(kept.revision,7)
        try await first.removeWindowSession(keepSession:true)
        try Data("external".utf8).write(to:file)
        let next=Bridge(webView:WKWebView(),options:options)
        let recoveredDraft=try snapshot(await call(next,"restoreDocument",["documentId":.string(draft.documentId),"path":.null]))
        let recoveredBound=try snapshot(await call(next,"restoreDocument",["documentId":.string(bound.documentId),"path":.string(file.path)]))
        XCTAssertEqual(recoveredDraft.text,"새 초안 👋");XCTAssertEqual(recoveredDraft.revision,4)
        XCTAssertEqual(recoveredBound.text,"최신 수정");XCTAssertEqual(recoveredBound.savedDigest,bound.savedDigest)
        do {_=try await call(next,"saveDocument",["documentId":.string(bound.documentId),"text":.string(recoveredBound.text),"revision":.number(7)]);XCTFail("Restoration must retain the digest conflict")}
        catch {XCTAssertEqual((error as? DocumentError)?.code,"conflict")}
        XCTAssertEqual(try String(contentsOf:file,encoding:.utf8),"external")
    }
    func testCleanFallbackClaimsIdentityAndExplicitDiscardRemovesDraft()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriSessionClean-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        let file=root.appendingPathComponent("saved.md");try Data("disk".utf8).write(to:file)
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path])
        let a=Bridge(webView:WKWebView(),options:options),b=Bridge(webView:WKWebView(),options:options)
        let clean=try snapshot(await call(a,"restoreDocument",["documentId":.string("stable"),"path":.string(file.path)]))
        XCTAssertEqual(clean.documentId,"stable");XCTAssertEqual(clean.text,"disk")
        do {_=try await call(b,"restoreDocument",["documentId":.string("stable"),"path":.string(file.path)]);XCTFail("Clean fallback must not steal ownership")}
        catch {XCTAssertEqual((error as? DocumentError)?.code,"conflict")}
        _=try await call(a,"checkpoint",["documentId":.string("stable"),"text":.string("draft"),"revision":.number(2)])
        _=try await call(a,"closeDocument",["documentId":.string("stable"),"discardRecovery":.bool(true)])
        do {_=try await call(b,"restoreDocument",["documentId":.string("stable"),"path":.null]);XCTFail("Discarded draft was restored")}
        catch {XCTAssertEqual((error as? DocumentError)?.code,"missing")}
    }
    func testStaleWindowCloseKeepsSessionAndLiveRecords()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriSessionClose-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let sessions=WindowSessionStore(dataDirectory:root)
        try await sessions.update(id:"owner",values:[:],frame:nil)
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path])
        let bridge=Bridge(webView:WKWebView(),options:options,windowSessions:sessions,windowID:"owner")
        let doc=await bridge.documents.create()
        var validations=0
        do {try await bridge.removeWindowSession(validate:{validations+=1;return validations==1});XCTFail("Stale close accepted")}
        catch {XCTAssertEqual((error as? BridgeError)?.code,"cancelled")}
        let retained=try await sessions.all();XCTAssertEqual(retained.map(\.id),["owner"])
        _=try await call(bridge,"checkpoint",["documentId":.string(doc.documentId),"text":.string("still editable"),"revision":.number(1)])
    }
}
