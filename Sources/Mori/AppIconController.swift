import AppKit
import DocumentCore

@MainActor
final class AppIconController {
    private let resourceDirectory: URL?

    init(resourceDirectory: URL? = Bundle.main.resourceURL) {
        self.resourceDirectory = resourceDirectory
    }

    static func validate(_ value: JSONValue?) throws {
        guard let value else { return }
        guard value == .string("ink") || value == .string("leaf") else {
            throw BridgeError.invalidRequest("appIcon must be ink or leaf.")
        }
    }

    static func normalizedSettings(_ settings: [String: JSONValue]) -> [String: JSONValue] {
        var result = settings
        result["appIcon"] = settings["appIcon"] == .string("leaf") ? .string("leaf") : .string("ink")
        return result
    }

    func apply(settings: [String: JSONValue]) {
        let name = settings["appIcon"] == .string("leaf") ? "leaf" : "ink"
        guard let url = resourceDirectory?.appendingPathComponent("AppIcon-\(name).icns"),
              let image = NSImage(contentsOf: url) else { return }
        NSApplication.shared.applicationIconImage = image
    }
}
