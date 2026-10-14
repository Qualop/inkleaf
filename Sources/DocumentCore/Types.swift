import Foundation
import CoreFoundation

public struct DocumentSnapshot: Codable, Sendable, Equatable {
    public var documentId: String
    public var path: String?
    public var text: String
    public var revision: Int
    public var savedDigest: String?
    public var encoding: String
    public var lineEnding: String

    public init(documentId: String, path: String?, text: String, revision: Int,
                savedDigest: String?, encoding: String, lineEnding: String) {
        self.documentId = documentId
        self.path = path
        self.text = text
        self.revision = revision
        self.savedDigest = savedDigest
        self.encoding = encoding
        self.lineEnding = lineEnding
    }
}

public enum DocumentError: Error, Sendable, Equatable, LocalizedError {
    case missing(String)
    case conflict(String)
    case invalidEncoding(String)
    case invalidPath(String)
    case unknownDocument(String)
    case io(String)

    public var code: String {
        switch self {
        case .missing: "missing"
        case .conflict: "conflict"
        case .invalidEncoding: "invalidEncoding"
        case .invalidPath: "invalidPath"
        case .unknownDocument: "unknownDocument"
        case .io: "io"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .missing(let detail): "File or recovery is missing: \(detail)"
        case .conflict(let detail): "Document conflict: \(detail)"
        case .invalidEncoding(let detail): "Unsupported or invalid text encoding: \(detail)"
        case .invalidPath(let detail): "Invalid path or operation: \(detail)"
        case .unknownDocument(let detail): "Unknown document: \(detail)"
        case .io(let detail): "File operation failed: \(detail)"
        }
    }
}

public struct WorkspaceEntry: Codable, Sendable, Equatable {
    public let path: String
    public let name: String
    public let isDirectory: Bool
    public let size: Int
    public let modified: Double
}

public struct WorkspaceMatch: Codable, Sendable, Equatable {
    public let path: String
    public let line: Int
    public let text: String
    /// Zero-based UTF-16 offsets within the line, suitable for JavaScript selections.
    public let from: Int
    public let to: Int
}

public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(foundationValue: Any) throws {
        switch foundationValue {
        case is NSNull: self = .null
        case let value as NSNumber:
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .bool(value.boolValue)
            } else {
                guard value.doubleValue.isFinite else { throw DocumentError.io("JSON numbers must be finite") }
                self = .number(value.doubleValue)
            }
        case let value as String: self = .string(value)
        case let value as [Any]: self = .array(try value.map { try JSONValue(foundationValue: $0) })
        case let value as [String: Any]: self = .object(try value.mapValues { try JSONValue(foundationValue: $0) })
        default: throw DocumentError.io("Value is not representable as JSON: \(type(of: foundationValue))")
        }
    }

    public var foundationValue: Any {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .number(let value): value
        case .string(let value): value
        case .array(let value): value.map(\.foundationValue)
        case .object(let value): value.mapValues(\.foundationValue)
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}
