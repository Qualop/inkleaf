import AppKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor final class UpdateMenuTests: XCTestCase {
    func testUpdateMenusUseApplicationCommandsAndLocalize() throws {
        _ = NSApplication.shared
        var sent: [NativeCommand] = []
        let menus = Menus { sent.append($0) }
        let bar = menus.makeMenu()
        let app = try XCTUnwrap(bar.items.first?.submenu)
        Menus.setLanguage("en")
        let check = try XCTUnwrap(app.items.first { $0.title == "Check for Updates…" })
        let automatic = try XCTUnwrap(app.items.first { $0.title == "Automatically Check for Updates" })
        XCTAssertTrue(check.isEnabled)
        _ = NSApplication.shared.sendAction(try XCTUnwrap(check.action), to: check.target, from: check)
        _ = NSApplication.shared.sendAction(try XCTUnwrap(automatic.action), to: automatic.target, from: automatic)
        XCTAssertEqual(sent.map(\.type), ["checkUpdates", "toggleAutomaticUpdates"])
        Menus.setLanguage("ko")
        XCTAssertEqual(check.title, "업데이트 확인…")
        XCTAssertEqual(automatic.title, "자동으로 업데이트 확인")
    }

    func testUpdateMenuTracksAvailabilityAndPersistedAutomaticChoice() throws {
        let menus = Menus { _ in }
        let bar = menus.makeMenu()
        Menus.setLanguage("en")
        let items = try XCTUnwrap(bar.items.first?.submenu).items
        let check = try XCTUnwrap(items.first { $0.title == "Check for Updates…" })
        let automatic = try XCTUnwrap(items.first { $0.title == "Automatically Check for Updates" })
        var enabled = true
        menus.updateState = { (enabled, enabled) }
        XCTAssertTrue(menus.validateMenuItem(check)); XCTAssertTrue(menus.validateMenuItem(automatic))
        XCTAssertEqual(automatic.state, .on)
        enabled = false
        XCTAssertFalse(menus.validateMenuItem(check)); XCTAssertTrue(menus.validateMenuItem(automatic))
        XCTAssertEqual(automatic.state, .off)
    }

    func testUnconfiguredDevelopmentExecutableDoesNotStartNetworkUpdater() {
        let updater = AppUpdateController()
        updater.start()
        XCTAssertFalse(updater.state.canCheck)
        XCTAssertFalse(updater.state.automatic)
        updater.toggleAutomaticChecks()
        XCTAssertFalse(updater.state.automatic)
    }

    func testMissingOrUnsafeFeedAndMalformedSigningKeysAreRejected() {
        let info: [String: Any] = ["CFBundleIdentifier": "dev.inkleaf.editor",
            "SUFeedURL": "https://raw.githubusercontent.com/Qualop/inkleaf/main/updates/appcast.xml",
            "SUPublicEDKey": Data(repeating: 1, count: 32).base64EncodedString()]
        XCTAssertTrue(AppUpdateController.isConfigured(info))
        for option in ["--data-dir", "--web-root"] {
            XCTAssertFalse(AppUpdateController.isConfigured(info, arguments: ["Inkleaf", option, "/tmp/audit"]))
        }
        for change in [["SUFeedURL": "http://example.com/feed.xml"], ["SUFeedURL": "file:///tmp/appcast.xml"],
                       ["SUFeedURL": "https:///no-host"], ["SUPublicEDKey": "invalid"], ["CFBundleIdentifier": "other.app"]] {
            XCTAssertFalse(AppUpdateController.isConfigured(info.merging(change) { _, new in new }))
        }
        XCTAssertFalse(AppUpdateController.isConfigured([:]))
    }
}
