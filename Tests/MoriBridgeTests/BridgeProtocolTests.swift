import Foundation
import XCTest
import DocumentCore
import ToolCore
@testable import Mori

final class BridgeProtocolTests: XCTestCase {
    func testRejectsMalformedRequests() {
        let malformed: [Any] = [NSNull(), [], [:], ["id": true, "method": "bootstrap", "args": [:]],
                                ["id": 1.5, "method": "bootstrap", "args": [:]],
                                ["id": 1, "method": "", "args": [:]],
                                ["id": 1, "method": "bootstrap", "args": []],
                                ["id": 9_007_199_254_740_992.0, "method": "bootstrap", "args": [:]]]
        for value in malformed { XCTAssertThrowsError(try NativeRequest.parse(value)) }
    }

    func testDecodesUnicodeAndExactText() throws {
        let request = try NativeRequest.parse(["id": 7, "method": "saveDocument",
                                             "args": ["text": "한글 😀\r\n", "revision": 3]])
        XCTAssertEqual(request.id, 7)
        XCTAssertEqual(try request.string("text"), "한글 😀\r\n")
        XCTAssertEqual(try request.integer("revision"), 3)
        XCTAssertThrowsError(try request.string("documentId"))
    }

    func testRejectsWrongArgumentTypes() throws {
        let request = try NativeRequest.parse(["id": 0, "method": "runTool",
                                             "args": ["revision": true, "arguments": ["ok", 1], "text": 2]])
        XCTAssertThrowsError(try request.integer("revision"))
        XCTAssertThrowsError(try request.strings("arguments"))
        XCTAssertThrowsError(try request.string("text"))
    }

    func testReplyEscapesExecutableTextAndPreservesNulls() throws {
        let text = "');window.injected=true;//\n\u{2028}한글"
        let snapshot = DocumentSnapshot(documentId: "doc", path: nil, text: text, revision: 2,
                                        savedDigest: nil, encoding: "utf8", lineEnding: "lf")
        let result = try NativeReply.encode(snapshot)
        let reply = NativeReply.success(id: 4, result: result)
        let data = try reply.data()
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let value = try XCTUnwrap(decoded["result"] as? [String: Any])
        XCTAssertEqual(value["text"] as? String, text)
        XCTAssertTrue(value["path"] is NSNull)
        XCTAssertTrue(value["savedDigest"] is NSNull)
        XCTAssertEqual(decoded["ok"] as? Bool, true)
    }

    func testMapsTypedFailureAndCancelledDialog() throws {
        let reply = NativeReply.failure(id: 9, error: DocumentError.conflict("/fixture.md"))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: reply.data()) as? [String: Any])
        let error = try XCTUnwrap(decoded["error"] as? [String: String])
        XCTAssertEqual(error["code"], "conflict")
        XCTAssertTrue(try NativeReply.failure(id: 1, error: BridgeError.cancelled).data().count > 0)
    }

    func testMissingExecutableErrorIncludesToolPath() throws {
        let reply = NativeReply.failure(id: 11, error: ProcessRunnerError.missingExecutable("/fixture/missing pandoc"))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: reply.data()) as? [String: Any])
        let error = try XCTUnwrap(decoded["error"] as? [String: String])
        XCTAssertEqual(error["code"], "missingExecutable")
        XCTAssertTrue(error["message"]?.contains("/fixture/missing pandoc") == true)
    }

    func testLaunchOptionsUseIsolatedDirectoriesAndRejectMissingPaths() throws {
        let options = try LaunchOptions(arguments: ["Mori", "--web-root", "/tmp/web fixture", "--data-dir", "/tmp/data fixture"])
        XCTAssertEqual(options.webRoot.path, "/tmp/web fixture")
        XCTAssertEqual(options.dataDirectory.path, "/tmp/data fixture")
        XCTAssertThrowsError(try LaunchOptions(arguments: ["Mori", "--data-dir"]))
        XCTAssertThrowsError(try LaunchOptions(arguments: ["Mori", "--web-root", "--data-dir", "/tmp/data"]))
    }
}
