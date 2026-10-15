import Foundation
public struct DocumentAssetReference: Codable, Sendable {
    public let path: String
    public let from: Int
    public let to: Int
    public let html: Bool
    public let suffix: String
    public init(path:String,from:Int,to:Int,html:Bool=false,suffix:String="") { self.path=path;self.from=from;self.to=to;self.html=html;self.suffix=suffix }
}

struct AssetPublication {
    let text: String
    let created: [URL]

    static func prepare(text:String, root:String?, destination:URL, references:[DocumentAssetReference]) throws -> AssetPublication {
        guard !references.isEmpty else { return AssetPublication(text:text,created:[]) }
        guard let root else { throw DocumentError.invalidPath("Missing image asset root") }
        let sourceRoot = try FileIO.url(root)
        // Resolve the existing parent separately; a new filename can retain an unresolved directory alias.
        let targetRoot = destination.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        let ns = text as NSString
        let sorted = references.sorted { $0.from < $1.from }
        var end = 0
        for reference in sorted {
            guard reference.from >= end, reference.to > reference.from, reference.to <= ns.length,
                  Range(NSRange(location:reference.from,length:reference.to-reference.from),in:text) != nil,
                  !reference.suffix.contains("\0") else { throw DocumentError.invalidPath("Invalid or overlapping image URL ranges") }
            let source = try FileIO.url(reference.path)
            guard source.pathComponents.starts(with:sourceRoot.pathComponents), source.pathComponents.count > sourceRoot.pathComponents.count else {
                throw DocumentError.invalidPath("Image is outside its declared asset root: \(reference.path)")
            }
            end = reference.to
        }
        if sourceRoot.pathComponents == targetRoot.pathComponents { return AssetPublication(text:text,created:[]) }
        let assets = targetRoot.appendingPathComponent("assets",isDirectory:true).resolvingSymlinksInPath()
        guard assets.pathComponents.starts(with:targetRoot.pathComponents), assets.pathComponents.count > targetRoot.pathComponents.count else {
            throw DocumentError.invalidPath("Destination image directory escapes the document root")
        }
        var created:[URL] = [], mapping:[String:String] = [:]
        do {
            try FileIO.directory(assets,create:true)
            for reference in sorted where mapping[reference.path] == nil {
                let source = try FileIO.url(reference.path), bytes = try FileIO.read(source)
                var attempt = 0
                while true {
                    let stem = source.deletingPathExtension().lastPathComponent
                    let ext = source.pathExtension.isEmpty ? "" : ".\(source.pathExtension)"
                    let name = attempt == 0 ? source.lastPathComponent : "\(stem)-\(attempt)\(ext)"
                    let target = assets.appendingPathComponent(name)
                    do {
                        try FileIO.write(bytes,to:target,overwrite:false);created.append(target)
                        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn:"-._~"))
                        mapping[reference.path] = "assets/" + (name.addingPercentEncoding(withAllowedCharacters:allowed) ?? name)
                        break
                    } catch DocumentError.conflict { attempt += 1 }
                }
            }
            let result = NSMutableString(string:text)
            for reference in sorted.reversed() {
                var url = mapping[reference.path]! + reference.suffix
                if reference.html { url = url.replacingOccurrences(of:"&",with:"&amp;").replacingOccurrences(of:"\"",with:"&quot;").replacingOccurrences(of:"'",with:"&#39;").replacingOccurrences(of:"<",with:"&lt;").replacingOccurrences(of:">",with:"&gt;") }
                result.replaceCharacters(in:NSRange(location:reference.from,length:reference.to-reference.from),with:url)
            }
            return AssetPublication(text:result as String,created:created)
        } catch {
            try rollback(created, because:error);throw error
        }
    }
    static func rollback(_ paths:[URL], because error:any Error) throws {
        var failures:[String] = []
        for path in paths.reversed() { do {try FileManager.default.removeItem(at:path)} catch {failures.append(path.path)} }
        if !failures.isEmpty {throw DocumentError.io("\(error.localizedDescription). Image copy rollback failed: \(failures.joined(separator:", "))")}
    }
}
