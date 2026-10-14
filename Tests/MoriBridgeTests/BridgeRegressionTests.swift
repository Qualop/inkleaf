import Foundation
import AppKit
import WebKit
import DocumentCore
import XCTest
import JavaScriptCore
@testable import Mori

final class BridgeRegressionTests: XCTestCase {
    @MainActor func testNativeQuitContextIsPassedAndApprovalIsReasonSpecific()throws {
        let context=try closeContext()
        context.evaluateScript("var closeReason=null;window.__moriBeforeClose=async reason=>{closeReason=reason;return true;}")
        XCTAssertTrue(try runCloseScript(NativeCloseContract.quitPrepareScript,in:context))
        XCTAssertEqual(context.objectForKeyedSubscript("closeReason")?.toString(),"quit")
        XCTAssertTrue(try runCloseScript(NativeCloseContract.quitValidationScript,in:context))
        XCTAssertFalse(try runCloseScript(NativeCloseContract.windowValidationScript,in:context))
    }
    @MainActor
    func testNativeCloseRequiresTheEditorCheckpointHook() throws {
        let context=try closeContext()
        context.evaluateScript("delete window.__moriBeforeClose")
        XCTAssertFalse(try runCloseScript(NativeCloseContract.prepareScript,in:context))
        XCTAssertFalse(try runCloseScript(NativeCloseContract.validationScript,in:context))
    }

    @MainActor
    func testNativeCloseDoesNotCheckpointUnfinishedComposition() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriComposition-"+UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:root)}
        let store=DocumentStore(dataDirectory:root),document=await store.create()
        try await store.checkpoint(id:document.documentId,text:"before",revision:1)
        let recoveryFile=try XCTUnwrap(FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("recoveries"),includingPropertiesForKeys:nil).first)
        let previousBytes=try Data(contentsOf:recoveryFile)
        let context=try closeContext()
        context.evaluateScript("var source='하'; window.__moriBeforeClose=async()=>{closeCalls++;checkpointText=source;return true;};emit('compositionstart');emit('input',{isComposing:true});")
        XCTAssertFalse(try runCloseScript(NativeCloseContract.prepareScript,in:context))
        XCTAssertEqual(context.objectForKeyedSubscript("closeCalls")?.toInt32(),0)
        XCTAssertEqual(try Data(contentsOf:recoveryFile),previousBytes)
        context.evaluateScript("source='한글 👋\\r\\n';emit('compositionend');emit('input',{isComposing:false});")
        XCTAssertFalse(try runCloseScript(NativeCloseContract.prepareScript,in:context),"The final input must settle before checkpointing")
        XCTAssertEqual(context.objectForKeyedSubscript("closeCalls")?.toInt32(),0)
        context.evaluateScript("drainInput()")
        XCTAssertTrue(try runCloseScript(NativeCloseContract.prepareScript,in:context))
        XCTAssertTrue(try runCloseScript(NativeCloseContract.validationScript,in:context))
        let text=try XCTUnwrap(context.objectForKeyedSubscript("checkpointText")?.toString())
        try await store.checkpoint(id:document.documentId,text:text,revision:2)
        await store.close(id:document.documentId)
        let restored=try await DocumentStore(dataDirectory:root).restore(id:document.documentId)
        XCTAssertEqual(restored.text,"한글 👋\r\n");XCTAssertEqual(restored.revision,2)
    }

    @MainActor
    func testInputWhileCloseHookIsPendingInvalidatesItsApproval() throws {
        let context=try closeContext()
        context.evaluateScript("window.__moriBeforeClose=async()=>{emit('input',{isComposing:false});drainInput();return true;}")
        XCTAssertFalse(try runCloseScript(NativeCloseContract.prepareScript,in:context))
        XCTAssertFalse(try runCloseScript(NativeCloseContract.validationScript,in:context))
    }

    @MainActor
    func testInputInAnEarlierWindowInvalidatesApprovalWhileAnotherWindowIsClosing() throws {
        let a=try closeContext(),b=try closeContext()
        XCTAssertTrue(try runCloseScript(NativeCloseContract.prepareScript,in:a))
        XCTAssertTrue(try runCloseScript(NativeCloseContract.prepareScript,in:b))
        a.evaluateScript("emit('input',{isComposing:false});drainInput()")
        XCTAssertFalse(try runCloseScript(NativeCloseContract.validationScript,in:a))
        XCTAssertTrue(try runCloseScript(NativeCloseContract.validationScript,in:b))
    }

    @MainActor
    private func closeContext()throws->JSContext {
        let context=try XCTUnwrap(JSContext())
        context.evaluateScript("""
        var window=globalThis,listeners={},timers=[],closeCalls=0,checkpointText=null;
        window.addEventListener=(type,listener)=>{(listeners[type]??=[]).push(listener);};
        window.setTimeout=callback=>{timers.push(callback);return timers.length;};
        function emit(type,fields={}){for(const listener of listeners[type]??[])listener(fields);}
        function drainInput(){while(timers.length)timers.shift()();}
        window.__moriBeforeClose=async()=>{closeCalls++;return true;};
        """)
        context.evaluateScript(NativeCloseContract.installScript)
        XCTAssertNil(context.exception?.toString())
        return context
    }

    @MainActor
    private func runCloseScript(_ script:String,in context:JSContext)throws->Bool {
        context.evaluateScript("var closeDone=false,closeValue=false,closeError=null;(async()=>{\(script)})().then(value=>{closeValue=value;closeDone=true;},error=>{closeError=String(error);closeDone=true;});")
        XCTAssertNil(context.exception?.toString())
        XCTAssertTrue(context.objectForKeyedSubscript("closeDone")?.toBool()==true,"Close promise did not settle")
        XCTAssertTrue(context.objectForKeyedSubscript("closeError")?.isNull==true)
        return try XCTUnwrap(context.objectForKeyedSubscript("closeValue")).toBool()
    }

    func testMalformedEnvelopeRetainsValidatedID() {
        XCTAssertEqual(BridgeRequestPolicy.correlationID(["id":7,"method":"saveAs","args":[]]),7)
        XCTAssertEqual(BridgeRequestPolicy.correlationID(["id":true]),-1)
        XCTAssertEqual(BridgeRequestPolicy.correlationID(["id":1.5]),-1)
        XCTAssertEqual(BridgeRequestPolicy.correlationID(["id":9_007_199_254_740_992.0]),-1)
        XCTAssertEqual(BridgeRequestPolicy.correlationID(NSNull()),-1)
    }
    func testPanelReplacementConsentIsAuthoritativeForChosenDestinationOnly() {
        XCTAssertTrue(BridgeRequestPolicy.saveAsOverwrite(explicitPath:nil,force:false))
        XCTAssertFalse(BridgeRequestPolicy.saveAsOverwrite(explicitPath:"/B.md",force:false))
        XCTAssertTrue(BridgeRequestPolicy.saveAsOverwrite(explicitPath:"/B.md",force:true))
    }
    @MainActor
    func testFormatRequestPreservesDiskUntilExplicitSave() async throws {
        _ = NSApplication.shared
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriFormatBridge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("data").path])
        let bridge=Bridge(webView:WKWebView(),options:options),path=root.appendingPathComponent("note.md")
        let text="한글 😀\r\nsource";try Data(text.utf8).write(to:path)
        let snapshot=try await bridge.documents.open(path:path.path)
        let request=try NativeRequest.parse(["id":1,"method":"setDocumentFormat","args":["documentId":snapshot.documentId,"text":text,"revision":1,"encoding":"utf16be"]])
        guard case .object(let result)=try await bridge.dispatch(request) else {return XCTFail("Expected snapshot")}
        XCTAssertEqual(result["encoding"],.string("utf16be"));XCTAssertEqual(result["text"],.string(text));XCTAssertEqual(try Data(contentsOf:path),Data(text.utf8))
        _ = try await bridge.documents.save(id:snapshot.documentId,text:text,revision:1)
        XCTAssertEqual(Array(try Data(contentsOf:path).prefix(2)),[0xfe,0xff])
    }

    func testSelectedAssetSerializerPreservesUnicodeAndSupportsOnlyExplicitMediaKinds() throws {
        for (kind,content) in [("tex","한글 $x+1$\r\n"),("mathml","<math><mi>한글</mi></math>"),("svg","<svg><text>한글</text></svg>")] {
            XCTAssertEqual(try BridgeRequestPolicy.assetBytes(kind:kind,content:content),Data(content.utf8))
        }
        XCTAssertThrowsError(try BridgeRequestPolicy.assetBytes(kind:"html",content:"<p>not selected media</p>"))
    }

    @MainActor
    func testBootstrapReturnsStableUntitledAssetRootForRestoration() async throws {
        _ = NSApplication.shared
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriRootBridge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("data").path])
        let bridge=Bridge(webView:WKWebView(),options:options)
        let request=try NativeRequest.parse(["id":1,"method":"bootstrap","args":[:]])
        guard case .object(let result)=try await bridge.dispatch(request) else {return XCTFail("Expected bootstrap object")}
        XCTAssertEqual(result["unsavedAssetRoot"],.string(options.dataDirectory.appendingPathComponent("unsaved",isDirectory:true).path))
    }

    @MainActor
    func testRecoveredUntitledImageIsReadableAndPublishedOnFirstSave() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriImageRecovery-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path])
        let original=Bridge(webView:WKWebView(),options:options)
        let png=try XCTUnwrap(Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII="))
        let imported=try await original.dispatch(NativeRequest(id:1,method:"importImages",args:["base64":.string(png.base64EncodedString()),"filename":.string("p a.png"),"documentPath":.null,"directory":.string("assets")]))
        guard case .array(let paths)=imported,case .string(let sourcePath)=paths.first else {return XCTFail("Expected imported image path")}
        let text="복구 👋\r\n![](assets/p%20a.png)\r\n"
        let document=await original.documents.create(text:text)
        _ = try await original.dispatch(NativeRequest(id:2,method:"checkpoint",args:["documentId":.string(document.documentId),"text":.string(text),"revision":.number(7)]))
        _ = try await original.dispatch(NativeRequest(id:3,method:"closeDocument",args:["documentId":.string(document.documentId)]))
        let restarted=Bridge(webView:WKWebView(),options:options)
        guard case .object(let bootstrap)=try await restarted.dispatch(NativeRequest(id:1,method:"bootstrap",args:[:])),
              case .string(let assetRoot)=bootstrap["unsavedAssetRoot"],case .array(let recoveries)=bootstrap["recoveries"] else {return XCTFail("Expected recovery bootstrap")}
        let restored=try JSONDecoder().decode([DocumentSnapshot].self,from:JSONEncoder().encode(JSONValue.array(recoveries)))
        XCTAssertEqual(restored.first?.documentId,document.documentId);XCTAssertEqual(restored.first?.text,text);XCTAssertEqual(restored.first?.revision,7)
        _ = try await restarted.dispatch(NativeRequest(id:4,method:"restoreDocument",args:["documentId":.string(document.documentId)]))
        guard case .object(let asset)=try await restarted.dispatch(NativeRequest(id:2,method:"readAsset",args:["root":.string(assetRoot),"path":.string("assets/p a.png")])) else {return XCTFail("Expected asset bytes")}
        XCTAssertEqual(asset["base64"],.string(png.base64EncodedString()))
        let destination=root.appendingPathComponent("published/note.md")
        try FileManager.default.createDirectory(at:destination.deletingLastPathComponent().appendingPathComponent("assets"),withIntermediateDirectories:true)
        let collision=destination.deletingLastPathComponent().appendingPathComponent("assets/p a.png");try Data([9]).write(to:collision)
        let range=(text as NSString).range(of:"assets/p%20a.png")
        let references=try NativeReply.encode([DocumentAssetReference(path:sourcePath,from:range.location,to:NSMaxRange(range))])
        _ = try await restarted.dispatch(NativeRequest(id:3,method:"saveAs",args:["documentId":.string(document.documentId),"path":.string(destination.path),"text":.string(text),"revision":.number(7),"assetRoot":.string(assetRoot),"imageReferences":references]))
        XCTAssertEqual(try Data(contentsOf:destination),Data("복구 👋\r\n![](assets/p%20a-1.png)\r\n".utf8))
        XCTAssertEqual(try Data(contentsOf:destination.deletingLastPathComponent().appendingPathComponent("assets/p a-1.png")),png)
        XCTAssertEqual(try Data(contentsOf:URL(fileURLWithPath:sourcePath)),png);XCTAssertEqual(try Data(contentsOf:collision),Data([9]))
        let afterSave=try await DocumentStore(dataDirectory:options.dataDirectory).recoveries();XCTAssertTrue(afterSave.isEmpty)
    }

    @MainActor
    func testCancelReplyDistinguishesCommittedOutputFromPostCommand() async throws {
        _ = NSApplication.shared
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriPostBridge-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("data").path])
        let bridge=Bridge(webView:WKWebView(),options:options),path=root.appendingPathComponent("out.md"),job="post-owned"
        let exportRequest=try NativeRequest.parse(["id":1,"method":"export","args":["format":"md","content":"published output","filename":"out.md","jobId":job,"options":["destination":path.path,"postCommand":"/bin/sleep","postArguments":["3"]]]])
        let exporting=Task {try await bridge.dispatch(exportRequest)}
        for _ in 0..<100 {if FileManager.default.fileExists(atPath:path.path){break};try await Task.sleep(for:.milliseconds(20))}
        let cancel=try NativeRequest.parse(["id":2,"method":"cancelTool","args":["jobId":job]])
        guard case .object(let result)=try await bridge.dispatch(cancel) else {return XCTFail("Expected cancellation object")}
        XCTAssertEqual(result["outputCreated"],.bool(true));XCTAssertEqual(result["path"],.string(path.path));XCTAssertEqual(try String(contentsOf:path,encoding:.utf8),"published output")
        guard case .object(let finished)=try await exporting.value else {return XCTFail("Expected export result")}
        XCTAssertEqual(finished["path"],.string(path.path))
    }

}
