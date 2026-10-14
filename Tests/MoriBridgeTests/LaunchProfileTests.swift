import XCTest
@testable import Mori

final class LaunchProfileTests: XCTestCase {
    func testFreshInstallUsesInkleafWithoutCreatingDirectories() throws {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-profile-\(UUID().uuidString)")
        let options = try LaunchOptions(arguments: ["Mori"], applicationSupportDirectory: support)
        XCTAssertEqual(options.dataDirectory.path, support.appendingPathComponent("Inkleaf").path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: support.path))
    }

    func testLegacyProfileWinsWithoutMovingOrChangingFiles() throws {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-profile-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: support) }
        for name in ["Mori", "Inkleaf"] {
            try FileManager.default.createDirectory(at: support.appendingPathComponent(name), withIntermediateDirectories: true)
            try Data(name.utf8).write(to: support.appendingPathComponent(name + "/settings.json"))
        }
        let options = try LaunchOptions(arguments: ["Mori"], applicationSupportDirectory: support)
        XCTAssertEqual(options.dataDirectory.path, support.appendingPathComponent("Mori").path)
        for name in ["Mori", "Inkleaf"] {
            XCTAssertEqual(try Data(contentsOf: support.appendingPathComponent(name + "/settings.json")), Data(name.utf8))
        }
    }

    func testExplicitDataDirectoryWinsOverBothProfiles() throws {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-profile-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: support) }
        try FileManager.default.createDirectory(at: support.appendingPathComponent("Mori"), withIntermediateDirectories: true)
        let explicit = support.appendingPathComponent("custom/../chosen")
        let options = try LaunchOptions(arguments: ["Mori", "--data-dir", explicit.path], applicationSupportDirectory: support)
        XCTAssertEqual(options.dataDirectory.path, support.appendingPathComponent("chosen").path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: options.dataDirectory.path))
    }

    func testFileNamedMoriDoesNotCountAsALegacyDirectory() throws {
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("Mori-profile-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: support) }
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: support.appendingPathComponent("Mori"))
        XCTAssertEqual(LaunchOptions.profileDirectory(explicitPath: nil, applicationSupportDirectory: support).path,
                       support.appendingPathComponent("Inkleaf").path)
        XCTAssertEqual(try Data(contentsOf: support.appendingPathComponent("Mori")), Data("keep".utf8))
    }
}
