import Foundation
import Darwin

public struct ThemeFile: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let css: String
}

/// Owns CSS files and display-name metadata in profile/themes. Rendering and OS dialogs belong to Bridge.
/// Imports embed local raster images/fonts and expand relative CSS imports (optional media queries).
/// Limits: 1MiB/CSS including output, 512KiB/asset, 4MiB aggregate input, 64 reads, import depth 4.
/// Paths stay beneath the selected CSS parent; symlinks, hardlinks, traversal, SVG, escaped identifiers,
/// escaped resource paths and layer/supports imports are rejected. No network requests are performed.
/// HTTP(S)/protocol-relative URL text remains; the renderer must block remote loading. Writes require
/// embedded data URLs for local resources. Publication is atomic per file, with process-local locking.
public actor ThemeStore {
    private struct Record: Codable { let id: String; let name: String }
    private static let lock = NSLock()
    private let dataDirectory: URL

    public init(dataDirectory: URL) { self.dataDirectory = dataDirectory }

    public func folder() throws -> String { try run { $0.path } }
    public func all() throws -> [ThemeFile] {
        try run { folder in
            try records(folder).map { record in
                let css = try ThemeCSS.utf8(ThemeFS.read(folder.appendingPathComponent(record.id + ".css"), root: folder, limit: ThemeCSS.cssLimit))
                try ThemeCSS.safe(css)
                return ThemeFile(id: record.id, name: record.name, css: css)
            }
        }
    }
    public func list() throws -> [ThemeFile] { try all() }

    public func importCSS(from source: URL) throws -> ThemeFile {
        guard ThemeFS.isLocal(source), source.pathExtension.lowercased() == "css" else { throw DocumentError.invalidPath("Select a local .css file.") }
        let root = source.deletingLastPathComponent().resolvingSymlinksInPath().standardizedFileURL
        let file = root.appendingPathComponent(source.lastPathComponent)
        let css = try ThemeImporter(root: root).expand(file)
        return try write(name: source.deletingPathExtension().lastPathComponent, css: css)
    }

    public func write(name: String, css: String, id: String? = nil) throws -> ThemeFile {
        try run { folder in
            try ThemeCSS.name(name)
            let bytes = try ThemeCSS.bytes(css); try ThemeCSS.safe(css)
            var entries = try records(folder)
            var selected: String
            var index: Int?
            if let id {
                try ThemeCSS.id(id)
                guard let owned = entries.firstIndex(where: { $0.id == id }) else { throw DocumentError.missing("Theme ID is not owned by this store.") }
                selected = id; index = owned
            } else {
                guard entries.count < 256 else { throw DocumentError.invalidPath("At most 256 themes may be stored.") }
                let owned = Set(entries.map(\.id)); var number = 1
                while try owned.contains("theme-\(number)") || ThemeFS.info(folder.appendingPathComponent("theme-\(number).css")) != nil {
                    number += 1
                    guard number <= 1_000_000 else { throw DocumentError.invalidPath("No available theme ID.") }
                }
                selected = "theme-\(number)"
            }
            let file = folder.appendingPathComponent(selected + ".css")
            let previous = try index.map { _ in try ThemeFS.read(file, root: folder, limit: ThemeCSS.cssLimit) }
            try FileIO.write(bytes, to: file, overwrite: index != nil)
            let record = Record(id: selected, name: name)
            if let index { entries[index] = record } else { entries.append(record) }
            do { try saveIndex(entries, folder: folder) }
            catch {
                if let previous { try FileIO.write(previous, to: file) }
                else { try FileManager.default.removeItem(at: file) }
                throw error
            }
            return ThemeFile(id: selected, name: name, css: css)
        }
    }

    public func remove(id: String) throws {
        try run { folder in
            try ThemeCSS.id(id)
            let entries = try records(folder)
            guard entries.contains(where: { $0.id == id }) else { throw DocumentError.missing("Theme ID is not owned by this store.") }
            let file = folder.appendingPathComponent(id + ".css")
            _ = try ThemeFS.read(file, root: folder, limit: ThemeCSS.cssLimit)
            try saveIndex(entries.filter { $0.id != id }, folder: folder)
            do { try FileManager.default.removeItem(at: file) }
            catch { try saveIndex(entries, folder: folder); throw error }
        }
    }

    private func run<T>(_ action: (URL) throws -> T) throws -> T {
        try Self.lock.withLock {
            guard ThemeFS.isLocal(dataDirectory) else { throw DocumentError.invalidPath("Theme profile must be a local directory.") }
            let profile = dataDirectory.resolvingSymlinksInPath().standardizedFileURL
            do {
                try FileIO.directory(profile, create: true)
                let folder = profile.appendingPathComponent("themes", isDirectory: true)
                if let info = try ThemeFS.info(folder) {
                    guard info.st_mode & S_IFMT == S_IFDIR else { throw DocumentError.invalidPath("Theme folder must be a real directory.") }
                } else { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false) }
                return try action(folder)
            } catch { throw FileIO.mapped(error, path: profile.path) }
        }
    }

    private func records(_ folder: URL) throws -> [Record] {
        let file = folder.appendingPathComponent("_index.json")
        guard try ThemeFS.info(file) != nil else { return [] }
        let data = try ThemeFS.read(file, root: folder, limit: ThemeCSS.cssLimit)
        let entries = try JSONDecoder().decode([Record].self, from: data)
        guard entries.count <= 256 else { throw DocumentError.invalidPath("Invalid theme metadata.") }
        var seen = Set<String>()
        for record in entries {
            try ThemeCSS.id(record.id); try ThemeCSS.name(record.name)
            guard seen.insert(record.id).inserted else { throw DocumentError.invalidPath("Duplicate theme ID.") }
        }
        return entries
    }

    private func saveIndex(_ entries: [Record], folder: URL) throws {
        let file = folder.appendingPathComponent("_index.json")
        if let info = try ThemeFS.info(file) {
            guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw DocumentError.invalidPath("Unsafe theme metadata file.") }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileIO.write(encoder.encode(entries), to: file)
    }
}

private enum ThemeFS {
    static func isLocal(_ url: URL) -> Bool { url.isFileURL && (url.host == nil || url.host == "" || url.host == "localhost") && !url.path.contains("\0") }
    static func info(_ file: URL) throws -> stat? {
        var result = stat()
        let status = file.withUnsafeFileSystemRepresentation { Darwin.lstat($0!, &result) }
        if status == 0 { return result }
        if errno == ENOENT { return nil }
        throw FileIO.mapped(NSError(domain: NSPOSIXErrorDomain, code: Int(errno)), path: file.path)
    }

    /// Walk with openat/O_NOFOLLOW so an intermediate symlink cannot redirect a resource read.
    static func read(_ file: URL, root: URL, limit: Int) throws -> Data {
        let prefix = root.path + "/"
        guard file.path.hasPrefix(prefix) else { throw DocumentError.invalidPath("Theme resource escapes its root.") }
        let parts = String(file.path.dropFirst(prefix.count)).split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw DocumentError.invalidPath("Invalid resource path.") }
        var parent = root.withUnsafeFileSystemRepresentation { Darwin.open($0!, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
        guard parent >= 0 else { throw DocumentError.invalidPath("Unsafe resource directory.") }
        defer { Darwin.close(parent) }
        for component in parts.dropLast() {
            let next = String(component).withCString { Darwin.openat(parent, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
            guard next >= 0 else { throw DocumentError.invalidPath("Unsafe resource directory.") }
            Darwin.close(parent); parent = next
        }
        let descriptor = String(parts.last!).withCString { Darwin.openat(parent, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) }
        guard descriptor >= 0 else {
            if errno == ELOOP { throw DocumentError.invalidPath("Resource symlinks are unsupported.") }
            throw FileIO.mapped(NSError(domain: NSPOSIXErrorDomain, code: Int(errno)), path: file.path)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0, metadata.st_mode & S_IFMT == S_IFREG, metadata.st_nlink == 1 else { throw DocumentError.invalidPath("Expected an unlinked regular theme file.") }
        guard metadata.st_size >= 0, metadata.st_size <= limit else { throw DocumentError.invalidPath("Theme input exceeds its byte limit.") }
        var result = Data()
        while let bytes = try handle.read(upToCount: min(65_536, limit + 1 - result.count)), !bytes.isEmpty {
            result.append(bytes)
            guard result.count <= limit else { throw DocumentError.invalidPath("Theme input exceeds its byte limit.") }
        }
        guard result.count == metadata.st_size else { throw DocumentError.invalidPath("Theme input changed while reading.") }
        return result
    }
}

private enum ThemeCSS {
    static let cssLimit = 1_048_576, assetLimit = 524_288
    static let mime: [String: String] = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "ico": "image/x-icon", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "eot": "application/vnd.ms-fontobject"]
    struct Token { let start: Int; let end: Int; let value: String; let media: String? }
    static func invalid(_ message: String) -> DocumentError { .invalidPath(message) }
    static func id(_ id: String) throws {
        guard id.range(of: "^theme-[1-9][0-9]{0,8}$", options: .regularExpression) != nil else { throw invalid("Invalid theme ID.") }
    }
    static func name(_ name: String) throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf8.count <= 1024,
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw invalid("Invalid theme name.") }
    }
    static func bytes(_ css: String) throws -> Data {
        guard css.utf8.count <= cssLimit, !css.utf8.contains(0) else { throw invalid("Theme CSS must be at most 1MiB and contain no NUL.") }
        return Data(css.utf8)
    }
    static func utf8(_ data: Data) throws -> String {
        guard let text = String(data: data, encoding: .utf8) else { throw DocumentError.invalidEncoding("Theme CSS must be valid UTF8.") }
        return text
    }
    static func retained(_ value: String) throws -> Bool {
        let lower = value.lowercased()
        if lower.hasPrefix("https://") || lower.hasPrefix("http://") || value.hasPrefix("//") || value.hasPrefix("#") { return true }
        if lower.hasPrefix("data:") {
            guard let delimiter = lower.range(of: ";base64,"), mime.values.contains(String(lower[lower.index(lower.startIndex, offsetBy: 5)..<delimiter.lowerBound])) else { throw invalid("Only base64 image/font data URLs are supported.") }
            let payload = String(value[delimiter.upperBound...])
            guard payload.utf8.count.isMultiple(of: 4), Data(base64Encoded: payload) != nil else { throw invalid("Invalid base64 data URL.") }
            return true
        }
        return false
    }
    static func safe(_ css: String) throws {
        for token in try tokens(css) {
            guard token.media == nil else { throw invalid("Use importCSS to expand local @import rules.") }
            guard try retained(token.value) else { throw invalid("Written CSS requires data URLs; local resources require importCSS.") }
        }
    }

    static func tokens(_ css: String) throws -> [Token] {
        let b = Array(try bytes(css)); var result: [Token] = []; var i = 0
        func text(_ start: Int, _ end: Int) -> String { String(decoding: b[start..<end], as: UTF8.self) }
        func word(_ c: UInt8) -> Bool { (65...90).contains(c) || (97...122).contains(c) || c == 95 || c == 45 }
        func whitespace(_ c: UInt8) -> Bool { [9, 10, 12, 13, 32].contains(c) }
        func comment(_ index: Int) -> Bool { index + 1 < b.count && b[index] == 47 && b[index + 1] == 42 }
        func trivia(_ start: Int) throws -> Int {
            var j = start
            while j < b.count {
                if whitespace(b[j]) { j += 1; continue }
                if j + 2 < b.count, b[j] == 239, b[j + 1] == 187, b[j + 2] == 191 { j += 3; continue }
                if comment(j) {
                    j += 2
                    while j + 1 < b.count && !(b[j] == 42 && b[j + 1] == 47) { j += 1 }
                    guard j + 1 < b.count else { throw invalid("Unterminated CSS comment.") }; j += 2; continue
                }
                break
            }
            return j
        }
        func quoted(_ start: Int, resource: Bool = false) throws -> (String, Int) {
            let quote = b[start]; var j = start + 1
            while j < b.count {
                if b[j] == 92 { if resource { throw invalid("Escaped resource paths are unsupported.") }; j += 2; continue }
                if b[j] == quote { return (text(start + 1, j), j + 1) }
                guard b[j] != 10 && b[j] != 13 else { throw invalid("Unterminated CSS string.") }; j += 1
            }
            throw invalid("Unterminated CSS string.")
        }
        func url(_ start: Int, _ open: Int) throws -> Token {
            var j = try trivia(open + 1); var value: String
            if j < b.count, b[j] == 34 || b[j] == 39 {
                let (ref, end) = try quoted(j, resource: true); value = ref; j = try trivia(end)
            } else {
                let begin = j; while j < b.count && b[j] != 41 { j += 1 }
                value = text(begin, j).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.utf8.contains(where: { whitespace($0) || [34, 39, 40, 41, 92].contains($0) }), !value.contains("/*") else { throw invalid("Unsupported CSS URL syntax.") }
            }
            guard j < b.count, b[j] == 41 else { throw invalid("Unterminated CSS URL.") }
            return Token(start: start, end: j + 1, value: value, media: nil)
        }
        while i < b.count {
            let skipped = try trivia(i); if skipped != i { i = skipped; continue }
            if b[i] == 34 || b[i] == 39 { i = try quoted(i).1; continue }
            guard b[i] != 92 else { throw invalid("Escaped CSS identifiers are unsupported.") }
            let start = i, at = b[i] == 64; if at { i += 1 }
            if i < b.count, word(b[i]) {
                let begin = i
                while i < b.count && (word(b[i]) || (48...57).contains(b[i])) { i += 1 }
                let identifier = text(begin, i).lowercased()
                if at && identifier == "import" {
                    i = try trivia(i); let ref: Token
                    if i < b.count, b[i] == 34 || b[i] == 39 {
                        let (value, end) = try quoted(i, resource: true); ref = Token(start: i, end: end, value: value, media: nil)
                    } else if i + 3 <= b.count, text(i, i + 3).lowercased() == "url" {
                        let open = try trivia(i + 3); guard open < b.count, b[open] == 40 else { throw invalid("Unsupported CSS import syntax.") }
                        ref = try url(i, open)
                    } else { throw invalid("Unsupported CSS import syntax.") }
                    i = try trivia(ref.end); let mediaStart = i; var nesting = 0
                    while i < b.count && !(b[i] == 59 && nesting == 0) {
                        guard ![123, 125, 64, 92, 34, 39].contains(b[i]), !comment(i) else { throw invalid("Unsupported CSS import condition.") }
                        if b[i] == 40 { nesting += 1 }
                        if b[i] == 41 { nesting -= 1; guard nesting >= 0 else { throw invalid("Invalid CSS import condition.") } }
                        i += 1
                    }
                    let media = text(mediaStart, i).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard i < b.count, nesting == 0, media.lowercased() != "layer", media.range(of: "\\b(?:layer|supports|url)\\s*\\(", options: [.regularExpression, .caseInsensitive]) == nil else { throw invalid("Unsupported CSS import condition.") }
                    i += 1; result.append(Token(start: start, end: i, value: ref.value, media: media))
                } else if !at && identifier == "url" {
                    let open = try trivia(i)
                    if open < b.count, b[open] == 40 { let ref = try url(start, open); result.append(ref); i = ref.end }
                }
                continue
            }
            if at && i < b.count && b[i] == 92 { throw invalid("Escaped CSS directives are unsupported.") }
            i += 1
        }
        return result
    }

    static func relative(_ value: String) throws -> [String] {
        guard !value.isEmpty, !value.contains("\\"), !value.hasPrefix("/"), value.range(of: "^[a-z][a-z0-9+.-]*:", options: [.regularExpression, .caseInsensitive]) == nil else { throw invalid("Resource must be a contained relative file.") }
        let raw = value.components(separatedBy: CharacterSet(charactersIn: "?#"))[0]
        guard let decoded = raw.removingPercentEncoding else { throw invalid("Invalid resource URL encoding.") }
        let parts = decoded.components(separatedBy: "/").filter { $0 != "." }
        guard parts.count <= 32, !parts.isEmpty else { throw invalid("Unsafe resource path.") }
        for part in parts {
            guard !part.isEmpty, part != "..", !part.hasSuffix("."), !part.hasSuffix(" "),
                  !part.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || "\\:<>\"|?*".unicodeScalars.contains($0) }),
                  part.range(of: "^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", options: [.regularExpression, .caseInsensitive]) == nil else { throw invalid("Unsafe resource path.") }
        }
        return parts
    }
}

private final class ThemeImporter {
    let root: URL
    var total = 0, reads = 0
    init(root: URL) { self.root = root }
    func read(_ file: URL, limit: Int) throws -> Data {
        reads += 1
        guard reads <= 64 else { throw ThemeCSS.invalid("Theme import exceeds 64 resource reads.") }
        let bytes = try ThemeFS.read(file, root: root, limit: limit); total += bytes.count
        guard total <= 4_194_304 else { throw ThemeCSS.invalid("Theme import exceeds 4MiB total input.") }
        return bytes
    }
    func resource(_ value: String, from file: URL) throws -> URL {
        var selected = file.deletingLastPathComponent()
        for part in try ThemeCSS.relative(value) { selected.appendPathComponent(part) }
        return selected
    }
    func expand(_ file: URL, depth: Int = 0, stack: Set<String> = []) throws -> String {
        guard depth <= 4, !stack.contains(file.path) else { throw ThemeCSS.invalid("Theme CSS import is cyclic or exceeds depth 4.") }
        let css = try ThemeCSS.utf8(read(file, limit: ThemeCSS.cssLimit)), input = Data(css.utf8)
        var output = Data(), offset = 0
        func append(_ bytes: Data) throws {
            guard output.count + bytes.count <= ThemeCSS.cssLimit else { throw ThemeCSS.invalid("Expanded theme exceeds 1MiB.") }
            output.append(bytes)
        }
        for token in try ThemeCSS.tokens(css) {
            try append(input.subdata(in: offset..<token.start))
            if let media = token.media {
                let child = try resource(token.value, from: file)
                guard child.pathExtension.lowercased() == "css" else { throw ThemeCSS.invalid("CSS imports must select .css files.") }
                let expanded = try expand(child, depth: depth + 1, stack: stack.union([file.path]))
                try append(Data((media.isEmpty ? expanded : "@media \(media) {\n\(expanded)\n}").utf8))
            } else if try ThemeCSS.retained(token.value) { try append(input.subdata(in: token.start..<token.end)) }
            else {
                let selected = try resource(token.value, from: file)
                guard let mime = ThemeCSS.mime[selected.pathExtension.lowercased()] else { throw ThemeCSS.invalid("Only raster images and font resources are supported.") }
                let bytes = try read(selected, limit: ThemeCSS.assetLimit)
                try append(Data("url(\"data:\(mime);base64,\(bytes.base64EncodedString())\")".utf8))
            }
            offset = token.end
        }
        try append(input.subdata(in: offset..<input.count))
        return String(decoding: output, as: UTF8.self)
    }
}
