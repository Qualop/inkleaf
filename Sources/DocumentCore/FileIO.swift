import Foundation
import CryptoKit
import Darwin

enum FileIO {
    // Window-local actors must share the final digest-check/replacement boundary.
    private static let commitLock = NSLock()
    static func url(_ path: String, resolveSymlinks: Bool = true) throws -> URL {
        guard path.hasPrefix("/"), !path.contains("\0") else { throw DocumentError.invalidPath(path) }
        let url = URL(fileURLWithPath: path).standardizedFileURL
        return resolveSymlinks ? url.resolvingSymlinksInPath() : url
    }

    static func directory(_ url: URL, create: Bool = false) throws {
        guard url.isFileURL else { throw DocumentError.invalidPath(url.absoluteString) }
        if create {
            do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
            catch { throw mapped(error, path: url.path) }
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw DocumentError.missing(url.path)
        }
        guard isDirectory.boolValue else { throw DocumentError.invalidPath(url.path) }
    }

    static func read(_ url: URL) throws -> Data {
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            guard values.isRegularFile == true else { throw DocumentError.invalidPath(url.path) }
            return try Data(contentsOf: url)
        } catch { throw mapped(error, path: url.path) }
    }

    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Hash the bound regular file without loading an external replacement into memory.
    static func diskDigest(_ url: URL) throws -> String {
        try Task.checkCancellation()
        guard url.isFileURL else { throw DocumentError.invalidPath(url.absoluteString) }
        let descriptor = url.withUnsafeFileSystemRepresentation {
            Darwin.open($0!, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        }
        guard descriptor >= 0 else {
            throw mapped(NSError(domain: NSPOSIXErrorDomain, code: Int(errno)), path: url.path)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var metadata = stat()
        guard Darwin.fstat(descriptor, &metadata) == 0 else {
            throw mapped(NSError(domain: NSPOSIXErrorDomain, code: Int(errno)), path: url.path)
        }
        guard metadata.st_mode & S_IFMT == S_IFREG else { throw DocumentError.invalidPath(url.path) }
        do {
            var hash = SHA256()
            while true {
                try Task.checkCancellation()
                guard let bytes = try handle.read(upToCount: 1_048_576), !bytes.isEmpty else { break }
                hash.update(data: bytes)
            }
            try Task.checkCancellation()
            return hash.finalize().map { String(format: "%02x", $0) }.joined()
        } catch is CancellationError { throw CancellationError() }
        catch { throw mapped(error, path: url.path) }
    }

    /// Stage a complete sibling file, then publish with one atomic filesystem operation.
    /// link() gives create-only writes an atomic no-overwrite guarantee even across actors.
    static func write(_ data: Data, to url: URL, overwrite: Bool = true,
                      beforeCommit: (() throws -> Void)? = nil) throws {
        try directory(url.deletingLastPathComponent())
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".mori-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            if overwrite, let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
               let mode = attributes[.posixPermissions] {
                try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: temporary.path)
            }
            let handle = try FileHandle(forWritingTo: temporary)
            defer { try? handle.close() }
            try handle.synchronize()
            try commitLock.withLock {
                try beforeCommit?()
                let result = temporary.withUnsafeFileSystemRepresentation { source in
                    url.withUnsafeFileSystemRepresentation { destination in
                        overwrite ? Darwin.rename(source!, destination!) : Darwin.link(source!, destination!)
                    }
                }
                guard result == 0 else {
                    let code = errno
                    if code == EEXIST { throw DocumentError.conflict(url.path) }
                    throw DocumentError.io("\(url.path): \(String(cString: strerror(code)))")
                }
            }
        } catch { throw mapped(error, path: url.path) }
    }

    static func mapped(_ error: any Error, path: String) -> DocumentError {
        if let error = error as? DocumentError { return error }
        let ns = error as NSError
        if (ns.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(ns.code)) ||
           (ns.domain == NSPOSIXErrorDomain && ns.code == Int(ENOENT)) {
            return .missing(path)
        }
        return .io("\(path): \(error.localizedDescription)")
    }
}

struct DecodedText {
    let text: String
    let encoding: String
    let hasBOM: Bool
}

enum TextCodec {
    static func decode(_ data: Data, path: String) throws -> DecodedText {
        let bytes = Array(data)
        if bytes.starts(with: [0xef, 0xbb, 0xbf]) {
            guard let text = String(bytes: bytes.dropFirst(3), encoding: .utf8) else { throw DocumentError.invalidEncoding(path) }
            return DecodedText(text: text, encoding: "utf8bom", hasBOM: true)
        }
        if bytes.starts(with: [0xff, 0xfe, 0, 0]) || bytes.starts(with: [0, 0, 0xfe, 0xff]) {
            throw DocumentError.invalidEncoding(path) // UTF-32 is outside the supported formats.
        }
        if bytes.starts(with: [0xff, 0xfe]) {
            return DecodedText(text: try utf16(Array(bytes.dropFirst(2)), littleEndian: true, path: path), encoding: "utf16le", hasBOM: true)
        }
        if bytes.starts(with: [0xfe, 0xff]) {
            return DecodedText(text: try utf16(Array(bytes.dropFirst(2)), littleEndian: false, path: path), encoding: "utf16be", hasBOM: true)
        }
        // BOM-less UTF-16 is identifiable when ASCII code units supply zero bytes.
        if bytes.count >= 2, bytes.count.isMultiple(of: 2), bytes.contains(0) {
            let evenZeros = stride(from: 0, to: bytes.count, by: 2).filter { bytes[$0] == 0 }.count
            let oddZeros = stride(from: 1, to: bytes.count, by: 2).filter { bytes[$0] == 0 }.count
            if evenZeros != oddZeros {
                let little = oddZeros > evenZeros
                return DecodedText(text: try utf16(bytes, littleEndian: little, path: path), encoding: little ? "utf16le" : "utf16be", hasBOM: false)
            }
        }
        guard let text = String(data: data, encoding: .utf8) else { throw DocumentError.invalidEncoding(path) }
        return DecodedText(text: text, encoding: "utf8", hasBOM: false)
    }

    private static func utf16(_ bytes: [UInt8], littleEndian: Bool, path: String) throws -> String {
        guard bytes.count.isMultiple(of: 2) else { throw DocumentError.invalidEncoding(path) }
        let units: [UInt16] = stride(from: 0, to: bytes.count, by: 2).map {
            littleEndian ? UInt16(bytes[$0]) | UInt16(bytes[$0 + 1]) << 8 : UInt16(bytes[$0]) << 8 | UInt16(bytes[$0 + 1])
        }
        var index = 0
        while index < units.count {
            let unit = units[index]
            if (0xd800...0xdbff).contains(unit) {
                guard index + 1 < units.count, (0xdc00...0xdfff).contains(units[index + 1]) else { throw DocumentError.invalidEncoding(path) }
                index += 2
            } else {
                guard !(0xdc00...0xdfff).contains(unit) else { throw DocumentError.invalidEncoding(path) }
                index += 1
            }
        }
        return String(decoding: units, as: UTF16.self)
    }

    static func encode(_ text: String, encoding: String, hasBOM: Bool) throws -> Data {
        switch encoding {
        case "utf8": return Data(text.utf8)
        case "utf8bom": return Data([0xef, 0xbb, 0xbf]) + Data(text.utf8)
        case "utf16le", "utf16be":
            let little = encoding == "utf16le"
            guard let data = text.data(using: little ? .utf16LittleEndian : .utf16BigEndian) else { throw DocumentError.invalidEncoding(encoding) }
            return (hasBOM ? Data(little ? [0xff, 0xfe] : [0xfe, 0xff]) : Data()) + data
        default: throw DocumentError.invalidEncoding(encoding)
        }
    }

    static func lineEnding(_ text: String) -> String {
        text.contains("\r\n") ? "CRLF" : "LF"
    }
}
