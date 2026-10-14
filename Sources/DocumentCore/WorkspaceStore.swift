import Foundation

public actor WorkspaceStore {
    private let dataDirectory: URL
    public init(dataDirectory: URL) { self.dataDirectory = dataDirectory }

    public func listDirectory(path: String) throws -> [WorkspaceEntry] {
        let url = try FileIO.url(path)
        try FileIO.directory(url)
        do {
            return try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey])
                .map { child in
                    let values = try child.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey])
                    return WorkspaceEntry(path: child.path, name: child.lastPathComponent, isDirectory: values.isDirectory == true,
                                          size: values.fileSize ?? 0, modified: values.contentModificationDate?.timeIntervalSince1970 ?? 0)
                }.sorted {
                    if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
                    return $0.name < $1.name
                }
        } catch { throw FileIO.mapped(error, path: path) }
    }

    public func search(path: String, query: String, caseSensitive: Bool = false, regex: Bool = false, wholeWord:Bool=false, limit: Int = 200) throws -> [WorkspaceMatch] {
        let root = try FileIO.url(path)
        try FileIO.directory(root)
        guard limit > 0, !query.isEmpty else { return [] }
        let expression: NSRegularExpression
        do {
            let raw=regex ? query : NSRegularExpression.escapedPattern(for:query)
            let pattern=wholeWord ? "(?<![\\p{L}\\p{N}\\p{M}\\p{Pc}])(?:\(raw))(?![\\p{L}\\p{N}\\p{M}\\p{Pc}])" : raw
            expression = try NSRegularExpression(pattern: pattern,
                                                 options: caseSensitive ? [] : [.caseInsensitive])
        } catch { throw DocumentError.invalidPath("Invalid search pattern: \(query)") }
        var matches: [WorkspaceMatch] = []
        try searchDirectory(root, expression: expression, limit: limit, matches: &matches)
        return matches
    }

    private func searchDirectory(_ directory: URL, expression: NSRegularExpression, limit: Int, matches: inout [WorkspaceMatch]) throws {
        if Task.isCancelled { throw DocumentError.io("Search cancelled") }
        let children: [URL]
        do { children = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey]).sorted { $0.path < $1.path } }
        catch { throw FileIO.mapped(error, path: directory.path) }
        for child in children {
            guard matches.count < limit else { return }
            if Task.isCancelled { throw DocumentError.io("Search cancelled") }
            let values: URLResourceValues
            do { values = try child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey]) }
            catch { throw FileIO.mapped(error, path: child.path) }
            guard values.isSymbolicLink != true else { continue }
            if values.isDirectory == true {
                try searchDirectory(child, expression: expression, limit: limit, matches: &matches)
            } else if values.isRegularFile == true {
                let bytes = try FileIO.read(child)
                let decoded: DecodedText
                do { decoded = try TextCodec.decode(bytes, path: child.path) }
                catch DocumentError.invalidEncoding { continue }
                guard !decoded.text.contains("\0") else { continue }
                let lines = decoded.text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
                for (index, text) in lines.enumerated() {
                    if Task.isCancelled { throw DocumentError.io("Search cancelled") }
                    for result in expression.matches(in: text, range: NSRange(location: 0, length: text.utf16.count)) {
                        matches.append(WorkspaceMatch(path: child.path, line: index + 1, text: text,
                                                      from: result.range.location, to: result.range.location + result.range.length))
                        if matches.count == limit { return }
                    }
                }
            }
        }
    }

    public func readAsset(path: String, root: String) throws -> Data {
        let rootURL = try FileIO.url(root)
        try FileIO.directory(rootURL)
        guard !path.isEmpty, !path.contains("\0") else { throw DocumentError.invalidPath(path) }
        let candidate = try FileIO.url(path.hasPrefix("/") ? path : rootURL.appendingPathComponent(path).path)
        let rootComponents = rootURL.pathComponents
        guard candidate.pathComponents.starts(with: rootComponents), candidate.pathComponents.count > rootComponents.count else {
            throw DocumentError.invalidPath(path)
        }
        return try FileIO.read(candidate)
    }

    public func importAssets(paths: [String], directory: String) throws -> [String] {
        let destination = try FileIO.url(directory)
        try FileIO.directory(destination, create: true)
        var imported: [String] = []
        for path in paths {
            let source = try FileIO.url(path)
            let bytes = try FileIO.read(source)
            let stem = source.deletingPathExtension().lastPathComponent
            let suffix = source.pathExtension.isEmpty ? "" : "." + source.pathExtension
            var attempt = 0
            while true {
                let name = attempt == 0 ? source.lastPathComponent : "\(stem)-\(attempt)\(suffix)"
                let candidate = destination.appendingPathComponent(name)
                do {
                    try FileIO.write(bytes, to: candidate, overwrite: false)
                    imported.append(candidate.path)
                    break
                } catch DocumentError.conflict { attempt += 1 }
            }
        }
        return imported
    }

    /// Supported operations: createFile, createDirectory, copy, rename, move, trash, delete.
    /// Destinations are absolute paths; copy/move/rename never overwrite an existing entry.
    public func manage(operation: String, path: String, destination: String?) throws -> String {
        // File management operates on the selected directory entry, including symbolic links.
        let source = try FileIO.url(path, resolveSymlinks: false)
        do {
            switch operation {
            case "createFile":
                try FileIO.write(Data(), to: source, overwrite: false)
                return source.path
            case "createDirectory":
                guard !FileManager.default.fileExists(atPath: source.path) else { throw DocumentError.conflict(source.path) }
                try FileManager.default.createDirectory(at: source, withIntermediateDirectories: false)
                return source.path
            case "copy", "move", "rename":
                guard let destination else { throw DocumentError.invalidPath("Missing destination for \(operation)") }
                let target = try FileIO.url(destination, resolveSymlinks: false)
                guard !FileManager.default.fileExists(atPath: target.path) else { throw DocumentError.conflict(target.path) }
                if operation == "copy" { try FileManager.default.copyItem(at: source, to: target) }
                else { try FileManager.default.moveItem(at: source, to: target) }
                return target.path
            case "trash":
                var result: NSURL?
                try FileManager.default.trashItem(at: source, resultingItemURL: &result)
                return result?.path ?? source.path
            case "delete":
                try FileManager.default.removeItem(at: source)
                return source.path
            default: throw DocumentError.invalidPath(operation)
            }
        } catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteFileExistsError {
                throw DocumentError.conflict(destination ?? path)
            }
            throw FileIO.mapped(error, path: path)
        }
    }
}
