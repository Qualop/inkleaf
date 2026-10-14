import XCTest
@testable import ToolCore

@MainActor
final class ToolCoreTests: XCTestCase {
    func testUnicodeArgumentsRemainSeparate() async throws {
        let result = try await ProcessRunner().run(jobId: "unicode", executable: "/usr/bin/printf", arguments: ["%s|%s", "한글 공백", "a;b"])
        XCTAssertEqual(result.stdout, "한글 공백|a;b")
        XCTAssertEqual(result.exitCode, 0)
    }
    func testInputBytesAreSentToRealProcess() async throws {
        let result = try await ProcessRunner().run(jobId: "input", executable: "/usr/bin/wc", arguments: ["-c"], input: "가나다\n")
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "10")
    }
    func testNonzeroExitPreservesErrorDiagnostic() async throws {
        let result = try await ProcessRunner().run(jobId: "failure", executable: "/bin/sh", arguments: ["-c", "printf problem >&2; exit 7"])
        XCTAssertEqual(result.exitCode, 7)
        XCTAssertEqual(result.stderr, "problem")
    }
    func testMissingExecutableIsExplicitError() async {
        do {
            _ = try await ProcessRunner().run(jobId: "missing", executable: "/not/a/tool", arguments: [])
            XCTFail("Missing tool should throw")
        } catch { XCTAssertTrue(error is ProcessRunnerError) }
    }
    func testDeadlineStopsOwnedProcess() async throws {
        let result = try await ProcessRunner().run(jobId: "timeout", executable: "/bin/sleep", arguments: ["3"], timeout: 0.1)
        XCTAssertTrue(result.timedOut)
        XCTAssertLessThan(result.duration, 2)
    }
    func testOutputLimitIsVisibleWhilePipeContinuesDraining() async throws {
        let result = try await ProcessRunner().run(jobId: "bounded", executable: "/usr/bin/printf", arguments: ["abcdefghijklmnop"], maxOutputBytes: 8)
        XCTAssertEqual(result.stdout, "abcdefgh")
        XCTAssertTrue(result.outputTruncated)
        XCTAssertEqual(result.exitCode, 0)
    }
    func testCancellationOnlyTargetsMatchingOwnedJob() async throws {
        let runner = ProcessRunner()
        let task = Task { try await runner.run(jobId: "cancel-me", executable: "/bin/sleep", arguments: ["3"]) }
        try await Task.sleep(for: .milliseconds(100))
        await runner.cancel(jobId: "cancel-me")
        let result = try await task.value
        XCTAssertTrue(result.cancelled)
        XCTAssertFalse(result.timedOut)
        XCTAssertLessThan(result.duration, 2)
    }
}
