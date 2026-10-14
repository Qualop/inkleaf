import XCTest
import DocumentCore
import ToolCore
@testable import Mori

final class PostExportTests:XCTestCase {
    @MainActor func testMalformedPostCommandDoesNotPublishOutput()async throws{
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriPostInvalid-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:root)}
        let target=root.appendingPathComponent("output.md"),exporter=ExportController(runner:ProcessRunner(),settings:SettingsStore(dataDirectory:root))
        let request=NativeRequest(id:1,method:"export",args:["format":.string("md"),"content":.string("new data"),"options":.object(["destination":.string(target.path),"postCommand":.string("/bin/echo"),"postArguments":.bool(true)])])
        do{_ = try await exporter.export(request,window:nil);XCTFail("Invalid post-command unexpectedly succeeded")}catch{}
        XCTAssertFalse(FileManager.default.fileExists(atPath:target.path))
    }
}
