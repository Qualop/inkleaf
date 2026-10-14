import Foundation

public actor SettingsStore {
    private let dataDirectory: URL
    private var settingsURL: URL { dataDirectory.appendingPathComponent("settings.json") }

    public init(dataDirectory: URL) { self.dataDirectory = dataDirectory }

    public func all() throws -> [String: JSONValue] {
        guard dataDirectory.isFileURL else { throw DocumentError.invalidPath(dataDirectory.absoluteString) }
        guard FileManager.default.fileExists(atPath: settingsURL.path) else { return [:] }
        do { return try JSONDecoder().decode([String: JSONValue].self, from: FileIO.read(settingsURL)) }
        catch { throw FileIO.mapped(error, path: settingsURL.path) }
    }

    public func update(values: [String: JSONValue]) throws -> [String: JSONValue] {
        var settings = try all()
        settings.merge(values) { _, new in new }
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
            let bytes = try encoder.encode(settings)
            try FileIO.directory(dataDirectory, create: true)
            try FileIO.write(bytes, to: settingsURL)
            return settings
        } catch { throw FileIO.mapped(error, path: settingsURL.path) }
    }
}
