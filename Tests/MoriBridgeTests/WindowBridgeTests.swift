import XCTest
import WebKit
import DocumentCore
@testable import Mori

@MainActor final class WindowBridgeTests:XCTestCase{
    func testBootstrapAndPersistenceAreBoundToTheOwningWindow()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriWindowBridge-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path]),store=WindowSessionStore(dataDirectory:root),settings=SettingsStore(dataDirectory:root)
        let a=try WindowSessionContent(values:["paths":.array([.string("/a.md")]),"activePath":.string("/a.md")]),b=try WindowSessionContent(values:["paths":.array([.string("/b.md")]),"activePath":.string("/b.md")])
        let bridgeA=Bridge(webView:WKWebView(),options:options,windowSessions:store,settingsStore:settings,windowID:"A",initialSession:a,inheritLegacySession:false)
        let bridgeB=Bridge(webView:WKWebView(),options:options,windowSessions:store,settingsStore:settings,windowID:"B",initialSession:b,inheritLegacySession:false)
        for (bridge,content) in [(bridgeA,a),(bridgeB,b)]{
            let result=try await bridge.dispatch(NativeRequest(id:1,method:"bootstrap",args:[:]))
            guard case .object(let envelope)=result,case .object(let prefs)=envelope["settings"] else{return XCTFail("Invalid bootstrap")}
            XCTAssertEqual(prefs["session"],content.json)
            _ = try await bridge.dispatch(NativeRequest(id:2,method:"settings",args:["values":.object(["session":content.json,"fontSize":.number(18)])]))
        }
        let restored=try await store.all();XCTAssertEqual(restored.map(\.content.paths),[["/a.md"],["/b.md"]])
        let global=try await settings.all();XCTAssertNil(global["session"]);XCTAssertEqual(global["fontSize"],.number(18))
        _ = try await bridgeA.dispatch(NativeRequest(id:3,method:"settings",args:["values":.object(["session":a.json,"fontSize":.number(20)])]))
        _ = try await bridgeB.dispatch(NativeRequest(id:3,method:"settings",args:["values":.object(["session":b.json,"fontSize":.number(18)])]))
        let latest=try await settings.all();XCTAssertEqual(latest["fontSize"],.number(20),"A session-only update must not restore stale preferences from another window")
        _ = try await bridgeB.dispatch(NativeRequest(id:4,method:"settings",args:["operation":.string("reset"),"values":.object(["session":b.json,"fontSize":.number(18)])]))
        let reset=try await settings.all();XCTAssertEqual(reset["fontSize"],.number(18))
        let restartedSettings=try await SettingsStore(dataDirectory:root).all()
        XCTAssertEqual(restartedSettings["fontSize"],.number(18));XCTAssertNil(restartedSettings["session"])
        _ = try await bridgeA.dispatch(NativeRequest(id:5,method:"settings",args:["values":.object(["session":a.json,"fontSize":.number(20)])]))
        let afterStaleWrite=try await SettingsStore(dataDirectory:root).all()
        XCTAssertEqual(afterStaleWrite["fontSize"],.number(18),"A routine write from the old window must not undo B's explicit reset")
        try await bridgeA.removeWindowSession();let left=try await store.all();XCTAssertEqual(left.map(\.id),["B"])
        do {
            _ = try await bridgeA.dispatch(NativeRequest(id:6,method:"settings",args:["operation":.string("reset"),"values":.object(["session":a.json,"fontSize":.number(30)])]))
            XCTFail("A closed window must not reset settings or reappear in persisted sessions")
        } catch { XCTAssertEqual((error as? BridgeError)?.code,"cancelled") }
        let persistedSessions=try await WindowSessionStore(dataDirectory:root).all()
        XCTAssertEqual(persistedSessions.map(\.id),["B"])
        XCTAssertEqual(persistedSessions[0].content,b)
        let afterClose=try await SettingsStore(dataDirectory:root).all();XCTAssertEqual(afterClose["fontSize"],.number(18))
    }

    func testConcurrentSaveRepliesAndRecoveryBelongToTheOwningWindow() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriWindowSave-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path])
        let a=Bridge(webView:WKWebView(),options:options),b=Bridge(webView:WKWebView(),options:options)
        let base=String(repeating:"한글 base\r\n",count:100_000)
        for round in 0..<4 {
            let path=root.appendingPathComponent("shared-\(round).md");try Data(base.utf8).write(to:path)
            let openedA=try Self.snapshot(await a.dispatch(NativeRequest(id:1,method:"openDocument",args:["path":.string(path.path)])))
            let openedB=try Self.snapshot(await b.dispatch(NativeRequest(id:1,method:"openDocument",args:["path":.string(path.path)])))
            XCTAssertNotEqual(openedA.documentId,openedB.documentId)
            let textA="window A\r\n"+base,textB="window B\r\n"+base
            func request(_ id:String,_ text:String,_ method:String="saveDocument",force:Bool=false)->NativeRequest {
                NativeRequest(id:2,method:method,args:["documentId":.string(id),"text":.string(text),"revision":.number(1),"force":.bool(force)])
            }
            _ = try await a.dispatch(request(openedA.documentId,textA,"checkpoint"))
            _ = try await b.dispatch(request(openedB.documentId,textB,"checkpoint"))
            async let resultA=Self.saveResult(a,request(openedA.documentId,textA))
            async let resultB=Self.saveResult(b,request(openedB.documentId,textB))
            let results=await [resultA,resultB]
            let successes=results.compactMap {try? $0.get()}
            XCTAssertEqual(successes.count,1)
            guard let saved=successes.first else {continue}
            let aWon=saved.documentId==openedA.documentId
            XCTAssertEqual(saved.documentId,aWon ? openedA.documentId:openedB.documentId)
            XCTAssertEqual(try Data(contentsOf:path),Data((aWon ? textA:textB).utf8))
            for result in results {if case .failure(let error)=result {XCTAssertEqual(error as? DocumentError,.conflict(path.path))}}
            let recoveries=try await DocumentStore(dataDirectory:options.dataDirectory).recoveries()
            XCTAssertEqual(recoveries.first(where:{$0.documentId==(aWon ? openedB.documentId:openedA.documentId)})?.text,aWon ? textB:textA)
            let loser=aWon ? b:a,loserID=aWon ? openedB.documentId:openedA.documentId
            do {
                _ = try await loser.dispatch(request(saved.documentId,"wrong window","checkpoint"))
                XCTFail("A window accepted another window's document identity")
            } catch {XCTAssertEqual(error as? DocumentError,.unknownDocument(saved.documentId))}
            let forced=try Self.snapshot(await loser.dispatch(request(loserID,aWon ? textB:textA,force:true)))
            XCTAssertEqual(forced.documentId,loserID)
            XCTAssertEqual(try Data(contentsOf:path),Data((aWon ? textB:textA).utf8))
        }
    }

    private static func snapshot(_ value:JSONValue)throws->DocumentSnapshot {
        try JSONDecoder().decode(DocumentSnapshot.self,from:JSONEncoder().encode(value))
    }
    private static func saveResult(_ bridge:Bridge,_ request:NativeRequest)async->Result<DocumentSnapshot,any Error> {
        do {return .success(try snapshot(await bridge.dispatch(request)))}catch{return .failure(error)}
    }

    func testRecoveryHasOneOwningWindowUntilItIsClosed() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriRecoveryOwner-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path])
        let path=root.appendingPathComponent("note.md");try Data("disk base".utf8).write(to:path)
        let original=DocumentStore(dataDirectory:options.dataDirectory),document=try await original.open(path:path.path)
        try await original.checkpoint(id:document.documentId,text:"recovered",revision:1)
        await original.close(id:document.documentId)
        let a=Bridge(webView:WKWebView(),options:options),b=Bridge(webView:WKWebView(),options:options)
        _ = try await a.dispatch(NativeRequest(id:1,method:"bootstrap",args:[:]))
        _ = try await b.dispatch(NativeRequest(id:1,method:"bootstrap",args:[:]))
        let unownedDestination=root.appendingPathComponent("unowned.md")
        do {
            _ = try await b.dispatch(NativeRequest(id:6,method:"saveAs",args:["documentId":.string(document.documentId),"path":.string(unownedDestination.path),"text":.string("unclaimed"),"revision":.number(2)]))
            XCTFail("A listed recovery must be explicitly restored before it can be saved")
        } catch {XCTAssertEqual(error as? DocumentError,.unknownDocument(document.documentId))}
        XCTAssertFalse(FileManager.default.fileExists(atPath:unownedDestination.path))
        _ = try await a.dispatch(NativeRequest(id:2,method:"restoreDocument",args:["documentId":.string(document.documentId)]))
        let recoveryFile=try XCTUnwrap(FileManager.default.contentsOfDirectory(at:options.dataDirectory.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil).first)
        let before=try Data(contentsOf:recoveryFile)
        do {
            _ = try await b.dispatch(NativeRequest(id:2,method:"restoreDocument",args:["documentId":.string(document.documentId)]))
            XCTFail("The same recovery identity must not be writable from two independent windows")
        } catch {XCTAssertEqual(error as? DocumentError,.conflict(document.documentId))}
        do {
            _ = try await b.dispatch(NativeRequest(id:3,method:"checkpoint",args:["documentId":.string(document.documentId),"text":.string("wrong window"),"revision":.number(2)]))
            XCTFail("Bootstrap must not grant ownership of every listed recovery")
        } catch {XCTAssertEqual(error as? DocumentError,.unknownDocument(document.documentId))}
        XCTAssertEqual(try Data(contentsOf:recoveryFile),before)
        _ = try await a.dispatch(NativeRequest(id:3,method:"checkpoint",args:["documentId":.string(document.documentId),"text":.string("owner A 최신\r\n"),"revision":.number(3)]))
        _ = try await a.dispatch(NativeRequest(id:4,method:"closeDocument",args:["documentId":.string(document.documentId)]))
        let transferred=try Self.snapshot(await b.dispatch(NativeRequest(id:4,method:"restoreDocument",args:["documentId":.string(document.documentId)])))
        XCTAssertEqual(transferred.text,"owner A 최신\r\n");XCTAssertEqual(transferred.revision,3)
        _ = try await b.dispatch(NativeRequest(id:5,method:"saveDocument",args:["documentId":.string(document.documentId),"text":.string(transferred.text),"revision":.number(3)]))
        XCTAssertEqual(try Data(contentsOf:path),Data("owner A 최신\r\n".utf8))
        let remaining=try await DocumentStore(dataDirectory:options.dataDirectory).recoveries();XCTAssertTrue(remaining.isEmpty)
    }

    func testWindowCloseReleasesRecoveryWhileCancelledToolRequestRetainsBridge() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriCloseLifetime-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path])
        var owner:Bridge?=Bridge(webView:WKWebView(),options:options,windowID:"owner")
        weak var retainedOwner=owner
        let document=await owner!.documents.create()
        try await owner!.documents.checkpoint(id:document.documentId,text:"kept recovery 한글 👋\r\n",revision:3)
        let recoveryFile=try XCTUnwrap(FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil).first)
        let before=try Data(contentsOf:recoveryFile),marker=root.appendingPathComponent("started")
        let gate=ClosedWindowRequestGate()
        let running=Task { [bridge=owner!] in
            let result=try await bridge.dispatch(Self.sleepRequest(marker:marker,seconds:"3"))
            await gate.wait()
            _ = try await bridge.documents.recoveries()
            return result
        }
        try await Self.waitForProcess(marker)
        try await owner!.removeWindowSession()
        owner=nil
        XCTAssertNotNil(retainedOwner,"The pending caller still retains Bridge; release cannot rely on deallocation")
        let next=Bridge(webView:WKWebView(),options:options)
        do {
            let restored=try Self.snapshot(await next.dispatch(NativeRequest(id:2,method:"restoreDocument",args:["documentId":.string(document.documentId)])))
            XCTAssertEqual(restored.documentId,document.documentId);XCTAssertEqual(restored.text,"kept recovery 한글 👋\r\n");XCTAssertEqual(restored.revision,3)
        } catch {XCTFail("Closed window still owns the recovery: \(error)")}
        XCTAssertEqual(try Data(contentsOf:recoveryFile),before)
        await gate.release()
        guard case .object(let result)=try await running.value else {return XCTFail("Expected tool result")}
        XCTAssertEqual(result["cancelled"],.bool(true));XCTAssertEqual(result["timedOut"],.bool(false))
        XCTAssertNotEqual(result["exitCode"],.number(0))
        XCTAssertEqual(try Data(contentsOf:recoveryFile),before)
    }

    func testClosedBridgeRejectsNewDocumentClaimsAndPersistence() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriClosedRequests-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path])
        let bridge=Bridge(webView:WKWebView(),options:options,windowID:"closed")
        let document=await bridge.documents.create()
        try await bridge.documents.checkpoint(id:document.documentId,text:"keep",revision:1)
        let recoveryFile=try XCTUnwrap(FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil).first)
        let before=try Data(contentsOf:recoveryFile)
        let source=root.appendingPathComponent("source.md"),destination=root.appendingPathComponent("must-not-save.md")
        try Data("source".utf8).write(to:source)
        try await bridge.removeWindowSession()
        let requests:[NativeRequest]=[
            NativeRequest(id:1,method:"createDocument",args:["text":.string("late")]),
            NativeRequest(id:2,method:"openDocument",args:["path":.string(source.path)]),
            NativeRequest(id:3,method:"restoreDocument",args:["documentId":.string(document.documentId)]),
            NativeRequest(id:4,method:"checkpoint",args:["documentId":.string(document.documentId),"text":.string("late"),"revision":.number(2)]),
            NativeRequest(id:5,method:"saveAs",args:["documentId":.string(document.documentId),"text":.string("late"),"revision":.number(2),"path":.string(destination.path)]),
            NativeRequest(id:6,method:"runTool",args:["jobId":.string("late"),"executable":.string("/bin/echo")]),
            NativeRequest(id:7,method:"settings",args:["values":.object(["session":WindowSessionContent.empty.json])])
        ]
        for request in requests {
            do {_ = try await bridge.dispatch(request);XCTFail("Closed bridge accepted \(request.method)")}
            catch {XCTAssertEqual((error as? BridgeError)?.code,"cancelled",request.method)}
        }
        XCTAssertEqual(try Data(contentsOf:recoveryFile),before)
        XCTAssertFalse(FileManager.default.fileExists(atPath:destination.path))
        let next=DocumentStore(dataDirectory:root),restored=try await next.restore(id:document.documentId)
        XCTAssertEqual(restored.text,"keep")
        try await bridge.removeWindowSession()
        do {_ = try await DocumentStore(dataDirectory:root).restore(id:document.documentId);XCTFail("Repeated close released another store's claim")}
        catch {XCTAssertEqual(error as? DocumentError,.conflict(document.documentId))}
    }

    func testFailedSessionRemovalKeepsDocumentsAndPendingProcessUsable() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriCloseFailure-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let sessions=WindowSessionStore(dataDirectory:root)
        try await sessions.update(id:"owner",values:[:],frame:nil)
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path])
        let owner=Bridge(webView:WKWebView(),options:options,windowSessions:sessions,windowID:"owner")
        let document=await owner.documents.create()
        try await owner.documents.checkpoint(id:document.documentId,text:"original recovery",revision:1)
        let sessionFile=root.appendingPathComponent("window-sessions.json"),validSessions=try Data(contentsOf:sessionFile)
        try Data("{".utf8).write(to:sessionFile)
        let marker=root.appendingPathComponent("started")
        let running=Task {try await owner.dispatch(Self.sleepRequest(marker:marker,seconds:"0.5"))}
        try await Self.waitForProcess(marker)
        do {try await owner.removeWindowSession();XCTFail("Corrupt session file must prevent removal")}
        catch {XCTAssertTrue(error is DocumentError)}
        XCTAssertEqual(try Data(contentsOf:sessionFile),Data("{".utf8))
        _ = try await owner.dispatch(NativeRequest(id:2,method:"checkpoint",args:["documentId":.string(document.documentId),"text":.string("still open 한글\r\n"),"revision":.number(2)]))
        _ = try await owner.dispatch(NativeRequest(id:3,method:"settings",args:["values":.object(["fontSize":.number(22)])]))
        let prefs=try await SettingsStore(dataDirectory:root).all();XCTAssertEqual(prefs["fontSize"],.number(22))
        let next=DocumentStore(dataDirectory:root)
        do {_ = try await next.restore(id:document.documentId);XCTFail("Failed removal must preserve the live owner's claim")}
        catch {XCTAssertEqual(error as? DocumentError,.conflict(document.documentId))}
        guard case .object(let result)=try await running.value else {return XCTFail("Expected tool result")}
        XCTAssertEqual(result["cancelled"],.bool(false));XCTAssertEqual(result["exitCode"],.number(0))
        try validSessions.write(to:sessionFile)
        try await owner.removeWindowSession()
        let restored=try await next.restore(id:document.documentId)
        XCTAssertEqual(restored.text,"still open 한글\r\n");XCTAssertEqual(restored.revision,2)
    }

    private static func sleepRequest(marker:URL,seconds:String)->NativeRequest {
        NativeRequest(id:10,method:"runTool",args:["jobId":.string("lifetime"),"executable":.string("/bin/sh"),"arguments":.array([.string("-c"),.string("printf ready > \"$1\"; exec /bin/sleep \"$2\""),.string("mori-test"),.string(marker.path),.string(seconds)]),"timeout":.number(8)])
    }
    private static func waitForProcess(_ marker:URL)async throws {
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath:marker.path) {return}
            try await Task.sleep(for:.milliseconds(20))
        }
        XCTFail("The real process never reached its sleep command")
        throw BridgeError.unavailable("Process fixture did not start")
    }
}

private actor ClosedWindowRequestGate {
    private var released=false
    private var continuation:CheckedContinuation<Void,Never>?
    func wait()async {
        if released {return}
        await withCheckedContinuation {continuation=$0}
    }
    func release() {released=true;continuation?.resume();continuation=nil}
}
