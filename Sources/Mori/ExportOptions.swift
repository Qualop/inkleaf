import Foundation
import AppKit
import DocumentCore

struct ExportGeometry {
    let width: Double
    let height: Double
    let margin: Double
    init(options: [String: JSONValue]) throws {
        let name:String
        if let value=options["paper"] { guard case .string(let text)=value else { throw BridgeError.invalidRequest("Paper must be a name.") };name=text.lowercased() }
        else { name="a4" }
        let sizes:[String:(Double,Double)] = ["a4":(210,297),"a5":(148,210),"letter":(215.9,279.4),"legal":(215.9,355.6),"tabloid":(279.4,431.8)]
        guard let size=sizes[name] else { throw BridgeError.invalidRequest("Unsupported paper size: \(name)") }
        let mm:Double
        if let value=options["margin"] { guard case .number(let number)=value,number.isFinite,number>=0,number<min(size.0,size.1)/2 else { throw BridgeError.invalidRequest("Margin must fit inside the paper.") };mm=number }
        else { mm=20 }
        width=size.0*72/25.4;height=size.1*72/25.4;margin=mm*72/25.4
    }
    static func writer(_ format:String) -> String? {
        ["docx":"docx","epub":"epub3","epub3":"epub3","odt":"odt","rtf":"rtf","latex":"latex",
         "rst":"rst","textile":"textile","opml":"opml","mediawiki":"mediawiki","wiki":"mediawiki",
         "gfm":"gfm","commonmark":"commonmark","org":"org","asciidoc":"asciidoc","fb2":"fb2"][format]
    }
    @MainActor func printInfo(destination:URL)->NSPrintInfo{
        let info=NSPrintInfo.shared.copy() as! NSPrintInfo
        info.paperSize=NSSize(width:width,height:height)
        info.leftMargin=margin;info.rightMargin=margin;info.topMargin=margin;info.bottomMargin=margin
        info.horizontalPagination = .fit;info.verticalPagination = .automatic
        info.isHorizontallyCentered=false;info.isVerticallyCentered=false;info.jobDisposition = .save
        info.dictionary().setObject(destination,forKey:NSPrintInfo.AttributeKey.jobSavingURL.rawValue as NSString)
        return info
    }
}
