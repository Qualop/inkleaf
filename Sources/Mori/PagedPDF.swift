import Foundation
import CoreGraphics
import PDFKit

/// Combines asynchronous WebKit vector captures into physical paper pages.
final class PagedPDF {
    private let context:CGContext
    private let geometry:ExportGeometry
    init(data:NSMutableData,geometry:ExportGeometry)throws{
        self.geometry=geometry
        var box=CGRect(x:0,y:0,width:geometry.width,height:geometry.height)
        guard let consumer=CGDataConsumer(data:data),let context=CGContext(consumer:consumer,mediaBox:&box,nil) else{throw BridgeError.unavailable("Could not create PDF output.")}
        self.context=context
    }
    static func slices(height:Double,pageHeight:Double,breaks:[Double],forced:[Double]=[],protected:[Range<Double>]=[])throws->[Range<Double>]{
        guard height.isFinite,height>0,height<=1_000_000,pageHeight.isFinite,pageHeight>0 else{throw BridgeError.invalidRequest("PDF document dimensions are invalid or exceed the limit.")}
        let protected=protected.filter{$0.lowerBound.isFinite && $0.upperBound.isFinite && $0.upperBound>$0.lowerBound && $0.upperBound-$0.lowerBound<=pageHeight}
        func safe(_ point:Double)->Bool{!protected.contains{$0.lowerBound<point && point<$0.upperBound}}
        let boundaries=protected.flatMap{[$0.lowerBound,$0.upperBound]}
        let candidates=(breaks+boundaries).filter{$0.isFinite && $0>0 && $0<height && safe($0)}.sorted()
        var result:[Range<Double>]=[],start=0.0
        while start<height{
            let desired=min(height,start+pageHeight)
            let forcedEnd=forced.filter{$0.isFinite && $0>start+1 && $0<=desired && safe($0)}.min()
            let preferred=candidates.last(where:{$0<=desired && $0>start+pageHeight*0.6})
            // A short page is preferable to splitting an object that fits on the next page.
            let fallback=safe(desired) ? desired : candidates.last(where:{$0<=desired && $0>start}) ?? desired
            let end=forcedEnd ?? (desired==height ? height : preferred ?? fallback)
            result.append(start..<end);start=end
        };return result
    }
    func append(_ data:Data,height:Double)throws{
        guard let provider=CGDataProvider(data:data as CFData),let document=CGPDFDocument(provider),let page=document.page(at:1) else{throw BridgeError.unavailable("WebKit generated an invalid PDF page.")}
        let box=page.getBoxRect(.mediaBox),width=geometry.width-2*geometry.margin
        guard box.width>0,box.height>0 else{throw BridgeError.unavailable("WebKit generated an empty PDF page.")}
        context.beginPDFPage(nil);context.saveGState()
        context.translateBy(x:geometry.margin,y:geometry.height-geometry.margin-height)
        context.scaleBy(x:width/box.width,y:height/box.height)
        context.clip(to:box)
        context.drawPDFPage(page)
        context.restoreGState();context.endPDFPage()
    }
    static func textMetrics(_ data:Data)throws->(height:Double,width:Double,breaks:[Double]){
        guard let document=PDFDocument(data:data),let page=document.page(at:0) else{throw BridgeError.unavailable("Could not measure captured PDF text.")}
        let box=page.bounds(for:.mediaBox)
        guard box.width.isFinite,box.height.isFinite,box.width>0,box.height>0 else{throw BridgeError.unavailable("Captured PDF dimensions are invalid.")}
        let ranges=page.selection(for:box)?.selectionsByLine() ?? []
        let breaks=ranges.map{selection->Double in let rect=selection.bounds(for:page);return box.maxY-rect.minY+2}
        return (box.height,box.width,breaks)
    }
    func finish(){context.closePDF()}
}
