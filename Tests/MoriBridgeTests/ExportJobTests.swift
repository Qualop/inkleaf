import XCTest
@testable import Mori

final class ExportJobTests:XCTestCase{
    func testCancellationBeforeDestinationSelectionPreventsCommit()throws{
        var jobs=ExportJobs();try jobs.begin("job");XCTAssertTrue(jobs.cancel("job"));XCTAssertThrowsError(try jobs.check("job"))
    }
    func testCompletedAndUnknownJobsCannotBeReportedCancelled()throws{
        var jobs=ExportJobs();XCTAssertFalse(jobs.cancel("unknown"));try jobs.begin("job");jobs.finish("job");XCTAssertFalse(jobs.cancel("job"))
    }
    func testDuplicateJobCannotReplaceOwnership()throws{
        var jobs=ExportJobs();try jobs.begin("job");XCTAssertThrowsError(try jobs.begin("job"));try jobs.check("job")
    }
    func testCommittedExportReportsCreatedPathDuringPostCommandCancellation()throws{
        var jobs=ExportJobs();try jobs.begin("job");jobs.commit("job",path:"/tmp/result.md")
        XCTAssertEqual(jobs.outputPath("job"),"/tmp/result.md");XCTAssertFalse(jobs.cancel("job"));jobs.finish("job");XCTAssertNil(jobs.outputPath("job"))
    }
}
