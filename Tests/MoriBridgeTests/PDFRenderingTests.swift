import AppKit
import WebKit
import PDFKit
import DocumentCore
import ToolCore
import XCTest
@testable import Mori

@MainActor final class PDFRenderingTests: XCTestCase {
    func testPaddedTableRowStaysOnOnePaperPageThroughActualExporter() async throws {
        _ = NSApplication.shared
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriPDFRow-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let destination=root.appendingPathComponent("row.pdf")
        let html="""
        <!doctype html><html><head><style>
        html,body{margin:0;padding:0;font:16px Helvetica;line-height:20px;background:white;color:black;}
        article{margin:0;padding:0;}
        .before{height:610px;display:flex;flex-direction:column;justify-content:space-between;}
        p{margin:0;}table{border-collapse:collapse;width:100%;table-layout:fixed;}
        td{height:180px;padding:0;vertical-align:top;border:1px solid black;background:rgb(0,181,255);}
        td p{padding:10px;} .tail{margin-top:40px;}
        </style></head><body><article>
        <div class="before"><p>PAGE_ONE_TOP</p><p>BEFORE_TABLE</p></div>
        <table><tbody><tr><td><p>TABLE_ROW_LABEL</p></td><td><p>SECOND_CELL</p></td></tr></tbody></table>
        <p class="tail">TAIL_END</p>
        </article></body></html>
        """
        let exporter=ExportController(runner:ProcessRunner(),settings:SettingsStore(dataDirectory:root.appendingPathComponent("state")))
        let request=NativeRequest(id:1,method:"export",args:["format":.string("pdf"),"content":.string(html),"jobId":.string("row"),"options":.object(["destination":.string(destination.path),"paper":.string("letter"),"margin":.number(12.7)])])
        _ = try await exporter.export(request,window:nil)
        let data=try Data(contentsOf:destination),document=try XCTUnwrap(PDFDocument(data:data))
        try preservePDFTestArtifact(data,name:"table-row")
        XCTAssertEqual(document.pageCount,2)
        var rowPages:[Int]=[]
        for index in 0..<document.pageCount {
            let raster=try PDFTestRaster(data:data,page:index)
            let bounds=raster.bounds {r,g,b in r<10 && g>160 && g<200 && b>245}
            print("PDF_ROW_PAGE \(index+1): blueBounds=\(String(describing:bounds)); mediaBox=\(document.page(at:index)!.bounds(for:.mediaBox))")
            if bounds != nil {rowPages.append(index)}
            let box=document.page(at:index)!.bounds(for:.mediaBox)
            XCTAssertEqual(box.width,612,accuracy:0.01);XCTAssertEqual(box.height,792,accuracy:0.01)
        }
        XCTAssertEqual(rowPages,[1],"The padded row's background and borders must move with its text to page two")
        XCTAssertEqual(visiblePDFTextPages(document,token:"TABLE_ROW_LABEL"),[1])
        XCTAssertEqual(visiblePDFTextPages(document,token:"TAIL_END"),[1])
    }

    func testOversizedSVGKeepsItsCompleteHeightAndTailWithinPaperMargins() async throws {
        let html="""
        <!doctype html><html><head><style>
        html,body{margin:0;padding:0;font:16px Helvetica;line-height:20px;background:white;color:black;}
        p{margin:0;}svg{display:block;}
        </style></head><body><article><p>INTRO</p>
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="1000"><rect width="200" height="1000" fill="rgb(0,200,0)"/></svg>
        <p>OVERSIZED_TAIL_END</p></article></body></html>
        """
        let data=try await exportedFixture(html,name:"oversized-svg"),document=try XCTUnwrap(PDFDocument(data:data))
        XCTAssertEqual(document.pageCount,2)
        var paintedHeight=0.0
        for index in 0..<document.pageCount {
            let raster=try PDFTestRaster(data:data,page:index)
            let green=try XCTUnwrap(raster.bounds {r,g,b in r<50 && g>160 && b<50})
            print("PDF_OVERSIZED_PAGE \(index+1): greenBounds=\(green)")
            paintedHeight+=green.height
            XCTAssertGreaterThanOrEqual(green.minY,35)
            XCTAssertLessThanOrEqual(green.maxY,757)
        }
        XCTAssertEqual(paintedHeight,1000,accuracy:2,"Cropping must preserve every point of the oversized object without painting it twice")
        XCTAssertEqual(visiblePDFTextPages(document,token:"OVERSIZED_TAIL_END"),[1])
    }

    func testSplitPagesPlacesMajorHeadingAtTheNextContentTopAndKeepsTail() async throws {
        let html="""
        <!doctype html><html><head><style>
        html,body{margin:0;padding:0;font:16px Helvetica;line-height:20px;background:white;color:black;}
        h1{margin:0;font-size:28px;line-height:40px;}p{margin:0;}
        </style></head><body><article><h1>FIRST_SECTION</h1><p>FIRST_BODY</p>
        <div style="height:180px"></div><h1>SECOND_SECTION</h1><p>SECTION_TAIL_END</p></article></body></html>
        """
        let data=try await exportedFixture(html,name:"major-headings",extra:["splitPages":.bool(true)])
        let document=try XCTUnwrap(PDFDocument(data:data))
        XCTAssertEqual(document.pageCount,2)
        XCTAssertEqual(visiblePDFTextPages(document,token:"FIRST_SECTION"),[0])
        XCTAssertEqual(visiblePDFTextPages(document,token:"SECOND_SECTION"),[1])
        XCTAssertEqual(visiblePDFTextPages(document,token:"SECTION_TAIL_END"),[1])
        let second=try XCTUnwrap(document.page(at:1))
        let selection=try XCTUnwrap(document.findString("SECOND_SECTION",withOptions:[]).first { $0.pages.contains(second) && second.bounds(for:.mediaBox).contains($0.bounds(for:second)) })
        let top=second.bounds(for:.mediaBox).maxY-selection.bounds(for:second).maxY
        print("PDF_SECOND_HEADING_TOP: \(top)")
        XCTAssertLessThan(top,60,"A forced heading boundary must not carry the preceding 180-point spacer onto the new page")
    }

    func testA4FractionalContentWidthKeepsTheCompleteColoredRightTableBorder() async throws {
        let html="""
        <!doctype html><html><head><style>
        html,body{margin:0;padding:0;font:16px Helvetica;line-height:20px;background:white;color:black;}
        p{margin:0 0 24px;}table{border-collapse:collapse;width:100%;table-layout:fixed;}
        td{height:40px;padding:0;border:1px solid black;}
        td:first-child{border-left-color:rgb(0,0,255);}
        td:last-child{border-right-color:rgb(255,0,255);}
        </style></head><body><article><p>A4_BORDER_FIXTURE</p>
        <table><tbody><tr><td>LEFT_ONE</td><td>RIGHT_ONE</td></tr>
        <tr><td>LEFT_TWO</td><td>RIGHT_TWO</td></tr>
        <tr><td>LEFT_THREE</td><td>RIGHT_THREE</td></tr></tbody></table>
        <p>A4_BORDER_TAIL</p></article></body></html>
        """
        let data=try await exportedFixture(html,name:"a4-right-border",extra:["paper":.string("a4"),"margin":.number(20)])
        let document=try XCTUnwrap(PDFDocument(data:data)),raster=try PDFTestRaster(data:data,scale:4)
        XCTAssertEqual(document.pageCount,1)
        let geometry=try ExportGeometry(options:["paper":.string("a4"),"margin":.number(20)])
        let box=try XCTUnwrap(document.page(at:0)).bounds(for:.mediaBox)
        XCTAssertEqual(box.width,595.2755905511812,accuracy:0.001)
        XCTAssertEqual(box.height,841.8897637795276,accuracy:0.001)
        let leftArea=raster.colorArea {r,g,b in max(0,Double(b)-Double(max(r,g)))/255}
        let rightArea=raster.colorArea {r,g,b in max(0,Double(min(r,b))-Double(g))/255}
        print("PDF_A4_BORDER_AREAS: left=\(leftArea), right=\(rightArea), ratio=\(rightArea/leftArea)")
        XCTAssertGreaterThan(leftArea,1000)
        XCTAssertGreaterThanOrEqual(rightArea,leftArea*0.9,"Equal one-CSS-pixel left/right borders must retain equal paint coverage")
        XCTAssertLessThanOrEqual(rightArea,leftArea*1.1)
        let right=try XCTUnwrap(raster.bounds {r,g,b in r>200 && b>200 && g<100})
        let edge=(geometry.width-geometry.margin)*4
        print("PDF_A4_RIGHT_BORDER_BOUNDS: \(right), contentRight=\(edge)")
        XCTAssertGreaterThan(right.height,400)
        XCTAssertLessThanOrEqual(right.maxX,ceil(edge)+1,"The border must stay inside the physical content margin")
        XCTAssertGreaterThanOrEqual(right.minX,edge-6)
        XCTAssertEqual(right.maxX/4,geometry.width-geometry.margin,accuracy:0.5)
        XCTAssertEqual(visiblePDFTextPages(document,token:"A4_BORDER_TAIL"),[0])
    }

    private func exportedFixture(_ html:String,name:String,extra:[String:JSONValue]=[:]) async throws->Data {
        _ = NSApplication.shared
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("MoriPDFRendering-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:root)}
        let destination=root.appendingPathComponent(name+".pdf")
        var options:[String:JSONValue]=["destination":.string(destination.path),"paper":.string("letter"),"margin":.number(12.7)]
        options.merge(extra){_,new in new}
        let exporter=ExportController(runner:ProcessRunner(),settings:SettingsStore(dataDirectory:root.appendingPathComponent("state")))
        _ = try await exporter.export(NativeRequest(id:1,method:"export",args:["format":.string("pdf"),"content":.string(html),"jobId":.string(name),"options":.object(options)]),window:nil)
        let data=try Data(contentsOf:destination)
        try preservePDFTestArtifact(data,name:name)
        return data
    }
}

struct PDFTestRaster {
    let width:Int,height:Int
    let bytes:[UInt8]
    init(data:Data,page:Int=0,scale:Double=1)throws {
        let provider=try XCTUnwrap(CGDataProvider(data:data as CFData)),document=try XCTUnwrap(CGPDFDocument(provider))
        let source=try XCTUnwrap(document.page(at:page+1)),box=source.getBoxRect(.mediaBox)
        width=Int(ceil(box.width*scale));height=Int(ceil(box.height*scale))
        let context=try XCTUnwrap(CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red:1,green:1,blue:1,alpha:1));context.fill(CGRect(x:0,y:0,width:width,height:height))
        context.scaleBy(x:scale,y:scale)
        context.translateBy(x:-box.minX,y:-box.minY);context.drawPDFPage(source)
        let pointer=try XCTUnwrap(context.data).assumingMemoryBound(to:UInt8.self)
        bytes=Array(UnsafeBufferPointer(start:pointer,count:width*height*4))
    }
    func bounds(matching color:(UInt8,UInt8,UInt8)->Bool)->CGRect? {
        var minX=width,minY=height,maxX = -1,maxY = -1
        for y in 0..<height {for x in 0..<width {
            let offset=(y*width+x)*4
            if color(bytes[offset],bytes[offset+1],bytes[offset+2]) {minX=min(minX,x);minY=min(minY,y);maxX=max(maxX,x);maxY=max(maxY,y)}
        }}
        return maxX<0 ? nil:CGRect(x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1)
    }
    func colorArea(coverage:(UInt8,UInt8,UInt8)->Double)->Double {
        var area=0.0
        for offset in stride(from:0,to:bytes.count,by:4) {area+=coverage(bytes[offset],bytes[offset+1],bytes[offset+2])}
        return area
    }
}

func visiblePDFTextPages(_ document:PDFDocument,token:String)->[Int] {
    var indexes=Set<Int>()
    for selection in document.findString(token,withOptions:[]) {
        for page in selection.pages {
            let bounds=selection.bounds(for:page)
            if !bounds.isEmpty && page.bounds(for:.mediaBox).contains(bounds) {indexes.insert(document.index(for:page))}
        }
    }
    return indexes.sorted()
}

func preservePDFTestArtifact(_ data:Data,name:String)throws {
    guard let path=ProcessInfo.processInfo.environment["MORI_PDF_TEST_ARTIFACTS"] else {return}
    let root=URL(fileURLWithPath:path,isDirectory:true)
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    try data.write(to:root.appendingPathComponent(name+".pdf"))
}
