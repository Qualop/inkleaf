import AppKit
import Sparkle

@MainActor
final class AppUpdateController {
    private var controller: SPUStandardUpdaterController?

    var state: (canCheck: Bool, automatic: Bool) {
        (controller?.updater.canCheckForUpdates ?? false,
         controller?.updater.automaticallyChecksForUpdates ?? false)
    }

    func start() {
        guard controller == nil, Self.isConfigured(Bundle.main.infoDictionary ?? [:], arguments: CommandLine.arguments) else { return }
        let updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        controller = updater
        updater.startUpdater()
    }

    func checkForUpdates() { controller?.checkForUpdates(nil) }

    func toggleAutomaticChecks() {
        guard let updater = controller?.updater else { return }
        updater.automaticallyChecksForUpdates.toggle()
    }

    static func isConfigured(_ info: [String: Any], arguments: [String] = []) -> Bool {
        guard !arguments.contains("--data-dir"), !arguments.contains("--web-root") else { return false }
        guard info["CFBundleIdentifier"] as? String == "dev.inkleaf.editor",
              let feed = info["SUFeedURL"] as? String, let url = URL(string: feed),
              url.scheme == "https", url.host != nil,
              let encoded = info["SUPublicEDKey"] as? String,
              Data(base64Encoded: encoded)?.count == 32 else { return false }
        return true
    }
}
