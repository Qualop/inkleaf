import XCTest
import WebKit
import DocumentCore
@testable import Mori

@MainActor final class BridgeFeatureTests:XCTestCase {
    func testThemeOperationsReturnManagedEntriesAndKeepImportedSourceUntouched()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriThemeBridge-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        let source=root.appendingPathComponent("personal.css");try Data(".cm-content {color:purple}".utf8).write(to:source)
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.appendingPathComponent("state").path]),bridge=Bridge(webView:WKWebView(),options:options)
        let imported=try await bridge.dispatch(NativeRequest(id:1,method:"themeFiles",args:["operation":.string("import"),"path":.string(source.path)]))
        guard case .object(let fields)=imported,case .object(let theme)=fields["theme"],case .string(let id)=theme["id"] else{return XCTFail("Missing imported theme metadata")}
        XCTAssertEqual(theme["css"],.string(".cm-content {color:purple}"));XCTAssertEqual(try String(contentsOf:source,encoding:.utf8),".cm-content {color:purple}")
        try FileManager.default.removeItem(at:source)
        let updated=try await bridge.dispatch(NativeRequest(id:2,method:"themeFiles",args:["operation":.string("write"),"id":.string(id),"name":.string("내 테마"),"css":.string(".cm-content {color:green}")]))
        guard case .object(let result)=updated,case .object(let edited)=result["theme"] else{return XCTFail("Missing edited theme")}
        XCTAssertEqual(edited["id"],.string(id));XCTAssertEqual(edited["name"],.string("내 테마"))
        let removed=try await bridge.dispatch(NativeRequest(id:3,method:"themeFiles",args:["operation":.string("remove"),"id":.string(id)]))
        guard case .object(let empty)=removed else{return XCTFail("Missing theme list")};XCTAssertEqual(empty["themes"],.array([]))
    }
    func testPersonalDictionaryLearningPersistsOnlyAppSettingsAndValidatesLanguage()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriDictionaryBridge-"+UUID().uuidString)
        defer{try? FileManager.default.removeItem(at:root)}
        let options=try LaunchOptions(arguments:["Mori","--web-root",root.path,"--data-dir",root.path]),bridge=Bridge(webView:WKWebView(),options:options)
        let learned=try await bridge.dispatch(NativeRequest(id:1,method:"proofread",args:["operation":.string("learn"),"word":.string(" 모리 ")]))
        guard case .object(let result)=learned else{return XCTFail("Missing dictionary result")};XCTAssertEqual(result["personalDictionary"],.array([.string("모리")]))
        _=try await bridge.dispatch(NativeRequest(id:2,method:"proofread",args:["operation":.string("learn"),"word":.string("모리")]))
        let settings=try await bridge.settings.all();XCTAssertEqual(settings["personalDictionary"],.array([.string("모리")]))
        do {_=try await bridge.dispatch(NativeRequest(id:3,method:"uiLanguage",args:["language":.string("xx")]));XCTFail("Invalid language accepted")}
        catch {XCTAssertEqual((error as? BridgeError)?.code,"invalidRequest")}
    }
}
