import XCTest
@testable import Mori
import DocumentCore
import AppKit

@MainActor
final class ExportOptionsTests: XCTestCase {
    func testA4DimensionsAndMillimeterMarginBecomePrintPoints() throws {
        let geometry = try ExportGeometry(options: ["paper":.string("A4"),"margin":.number(20)])
        XCTAssertEqual(geometry.width, 595.27559, accuracy: 0.001)
        XCTAssertEqual(geometry.height, 841.88976, accuracy: 0.001)
        XCTAssertEqual(geometry.margin, 56.69291, accuracy: 0.001)
    }
    func testLetterHasRealPaperDimensions() throws {
        let geometry = try ExportGeometry(options: ["paper":.string("letter"),"margin":.number(10)])
        XCTAssertEqual(geometry.width, 612, accuracy: 0.001)
        XCTAssertEqual(geometry.height, 792, accuracy: 0.001)
    }
    func testInvalidPaperAndMarginAreExplicitErrors() {
        XCTAssertThrowsError(try ExportGeometry(options: ["paper":.string("nonsense")]))
        XCTAssertThrowsError(try ExportGeometry(options: ["margin":.number(-1)]))
    }
    func testLatexUsesConversionWriterAndUnsupportedFormatHasNoWriter() {
        XCTAssertEqual(ExportGeometry.writer("latex"), "latex")
        XCTAssertEqual(ExportGeometry.writer("docx"), "docx")
        XCTAssertNil(ExportGeometry.writer("unknown"))
    }
    func testNativePdfJobCarriesItsAuthorizedDestinationWithoutSecondSaveDialog()throws{
        let url=URL(fileURLWithPath:"/tmp/mori-explicit-output.pdf")
        let info=try ExportGeometry(options:[:]).printInfo(destination:url)
        XCTAssertEqual(info.jobDisposition,.save)
        XCTAssertEqual(info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] as? URL,url)
    }
}
