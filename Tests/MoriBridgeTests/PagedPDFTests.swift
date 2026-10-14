import XCTest
import PDFKit
import CoreText
@testable import Mori

final class PagedPDFTests:XCTestCase {
    func testPageSlicesRetainTailAndAvoidCuttingKnownLines()throws{
        let slices=try PagedPDF.slices(height:1500,pageHeight:700,breaks:[680,1360,1499])
        XCTAssertEqual(slices,[0..<680,680..<1360,1360..<1500])
        XCTAssertThrowsError(try PagedPDF.slices(height:.infinity,pageHeight:700,breaks:[]))
    }
    func testMajorHeadingBreakStartsNewPageEvenWhenPreviousPageHasSpace()throws{
        XCTAssertEqual(try PagedPDF.slices(height:1500,pageHeight:700,breaks:[300,900,1450],forced:[300]),[0..<300,300..<900,900..<1500])
    }
    func testObjectBoundaryBeforeSixtyPercentStillKeepsTheObjectIntact()throws {
        let slices=try PagedPDF.slices(height:1000,pageHeight:700,breaks:[200,800],protected:[200..<800])
        XCTAssertEqual(slices,[0..<200,200..<800,800..<1000])
    }
    func testOversizedObjectPermitsProgressAndRetainsTheLastSlice()throws {
        let slices=try PagedPDF.slices(height:1100,pageHeight:700,breaks:[20,1020],protected:[20..<1020])
        XCTAssertEqual(slices,[0..<700,700..<1100])
    }
    func testComposerMakesSeparatePaperPagesWithSearchableTail()throws{
        let geometry=try ExportGeometry(options:[:]),data=NSMutableData()
        let composer=try PagedPDF(data:data,geometry:geometry)
        for text in ["FIRST_PAGE","LAST_PAGE_END"]{
            let source=NSMutableData(),consumer=CGDataConsumer(data:source)!,rect=CGRect(x:0,y:0,width:300,height:400)
            var box=rect;let context=CGContext(consumer:consumer,mediaBox:&box,nil)!
            context.beginPDFPage(nil);context.textPosition=CGPoint(x:15,y:200)
            let attr=NSAttributedString(string:text,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):CTFontCreateWithName("Helvetica" as CFString,12,nil)])
            CTLineDraw(CTLineCreateWithAttributedString(attr),context);context.endPDFPage();context.closePDF()
            try composer.append(source as Data,height:400)
        }
        composer.finish();let pdf=try XCTUnwrap(PDFDocument(data:data as Data))
        XCTAssertEqual(pdf.pageCount,2);XCTAssertTrue(pdf.string?.contains("LAST_PAGE_END")==true)
        XCTAssertEqual(pdf.page(at:0)!.bounds(for:.mediaBox).width,geometry.width,accuracy:0.01)
    }

    func testComposerClipsPaintOutsideCapturedMediaBox()throws {
        let source=NSMutableData(),consumer=try XCTUnwrap(CGDataConsumer(data:source))
        var sourceBox=CGRect(x:0,y:0,width:200,height:100)
        let sourceContext=try XCTUnwrap(CGContext(consumer:consumer,mediaBox:&sourceBox,nil))
        sourceContext.beginPDFPage(nil)
        sourceContext.setFillColor(CGColor(red:1,green:0,blue:0,alpha:1))
        sourceContext.fill(CGRect(x:20,y:80,width:50,height:50))
        sourceContext.endPDFPage();sourceContext.closePDF()
        let geometry=try ExportGeometry(options:[:]),output=NSMutableData(),composer=try PagedPDF(data:output,geometry:geometry)
        try composer.append(source as Data,height:100);composer.finish()
        try preservePDFTestArtifact(output as Data,name:"media-box-clip")
        let raster=try PDFTestRaster(data:output as Data)
        let red=try XCTUnwrap(raster.bounds {r,g,b in r>200 && g<100 && b<100})
        print("PDF_CLIP_RED_BOUNDS: \(red)")
        XCTAssertEqual(red.height,20,accuracy:1,"Only the 20 points inside the captured MediaBox may reach the paper page")
    }
}
