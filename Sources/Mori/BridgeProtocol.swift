import Foundation
import CoreFoundation
import DocumentCore
import ToolCore

public enum BridgeError: Error, LocalizedError, Sendable {
    case invalidRequest(String)
    case cancelled
    case unsupported(String)
    case unavailable(String)
    case toolFailed(String)

    public var code: String {
        switch self {
        case .invalidRequest: "invalidRequest"
        case .cancelled: "cancelled"
        case .unsupported: "unsupported"
        case .unavailable: "unavailable"
        case .toolFailed: "toolFailed"
        }
    }
    public var errorDescription: String? {
        switch self {
        case .invalidRequest(let detail), .unsupported(let detail), .unavailable(let detail), .toolFailed(let detail): detail
        case .cancelled: "Operation cancelled."
        }
    }
}

public struct NativeRequest: Sendable {
    public let id: Int
    public let method: String
    public let args: [String: JSONValue]

    public static func parse(_ body: Any) throws -> NativeRequest {
        guard let object = body as? [String: Any],
              let number = object["id"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              abs(number.doubleValue) <= 9_007_199_254_740_991,
              let method = object["method"] as? String, !method.isEmpty,
              let args = object["args"] as? [String: Any] else {
            throw BridgeError.invalidRequest("Expected {id: integer, method: nonempty string, args: object}.")
        }
        return NativeRequest(id: number.intValue, method: method, args: try args.mapValues { try JSONValue(foundationValue: $0) })
    }
    public func string(_ key: String) throws -> String {
        guard case .string(let value) = args[key] else { throw invalid(key, "string") }
        return value
    }
    public func optionalString(_ key: String) throws -> String? {
        guard let value = args[key], value != .null else { return nil }
        guard case .string(let string) = value else { throw invalid(key, "string") }
        return string
    }
    public func integer(_ key: String, default fallback: Int? = nil) throws -> Int {
        if args[key] == nil, let fallback { return fallback }
        guard case .number(let value) = args[key], value.isFinite, value.rounded() == value,
              abs(value) <= 9_007_199_254_740_991 else { throw invalid(key, "integer") }
        return Int(value)
    }
    public func number(_ key: String, default fallback: Double) throws -> Double {
        guard let value = args[key] else { return fallback }
        guard case .number(let number) = value, number.isFinite else { throw invalid(key, "number") }
        return number
    }
    public func boolean(_ key: String, default fallback: Bool = false) throws -> Bool {
        guard let value = args[key] else { return fallback }
        guard case .bool(let boolean) = value else { throw invalid(key, "boolean") }
        return boolean
    }
    public func strings(_ key: String, default fallback: [String]? = nil) throws -> [String] {
        if args[key] == nil, let fallback { return fallback }
        guard case .array(let array) = args[key] else { throw invalid(key, "string array") }
        return try array.map { value in
            guard case .string(let string) = value else { throw invalid(key, "string array") }
            return string
        }
    }
    public func object(_ key: String, default fallback: [String: JSONValue] = [:]) throws -> [String: JSONValue] {
        guard let value = args[key] else { return fallback }
        guard case .object(let object) = value else { throw invalid(key, "object") }
        return object
    }
    private func invalid(_ key: String, _ type: String) -> BridgeError {
        .invalidRequest("Argument '\(key)' must be a \(type).")
    }
}

public struct NativeReply: Sendable {
    let value: JSONValue
    public static func success(id: Int, result: JSONValue = .null) -> NativeReply {
        NativeReply(value: .object(["id": .number(Double(id)), "ok": .bool(true), "result": result]))
    }
    public static func failure(id: Int, error: any Error) -> NativeReply {
        let code: String
        var message = error.localizedDescription
        if let error = error as? DocumentError { code = error.code }
        else if let error = error as? BridgeError { code = error.code }
        else if error is CancellationError { code = "cancelled" }
        else if let error = error as? ProcessRunnerError {
            switch error {
            case .missingExecutable(let path):
                code = "missingExecutable"
                message = "Executable was not found or is not executable: \(path)"
            case .invalidJob(let jobId):
                code = "invalidJob"
                message = "Tool job ID is empty or already running: \(jobId)"
            case .launchFailed(let reason):
                code = "launchFailed"
                message = "Tool could not start: \(reason)"
            }
        } else { code = "io" }
        return NativeReply(value: .object(["id": .number(Double(id)), "ok": .bool(false),
            "error": .object(["code": .string(code), "message": .string(message)])]))
    }
    public static func encode<T: Encodable>(_ value: T) throws -> JSONValue {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
        return normalizeSnapshots(try JSONValue(foundationValue: object))
    }
    private static func normalizeSnapshots(_ value: JSONValue) -> JSONValue {
        switch value {
        case .array(let values): return .array(values.map(normalizeSnapshots))
        case .object(var object):
            object = object.mapValues(normalizeSnapshots)
            if object["documentId"] != nil, object["savedDigest"] == nil { object["savedDigest"] = .null }
            if object["documentId"] != nil, object["path"] == nil { object["path"] = .null }
            return .object(object)
        default: return value
        }
    }
    public func data() throws -> Data {
        try JSONSerialization.data(withJSONObject: value.foundationValue, options: [.sortedKeys, .fragmentsAllowed])
    }
    public func javaScript() throws -> String {
        // Serialized data is passed as an expression, never interpolated into a quoted JS string.
        let json = String(decoding: try data(), as: UTF8.self)
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "window.__nativeReply(\(json));"
    }
}
