import AppKit
import WebKit
import DocumentCore

@main
struct MoriApp {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = AppDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

struct LaunchOptions {
    let webRoot: URL
    let dataDirectory: URL

    init(arguments: [String] = CommandLine.arguments, applicationSupportDirectory: URL? = nil) throws {
        var web: String?
        var data: String?
        var index = 1
        while index < arguments.count {
            let flag = arguments[index]
            if flag == "--web-root" || flag == "--data-dir" {
                guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") else {
                    throw BridgeError.invalidRequest("\(flag) requires a path.")
                }
                if flag == "--web-root" { web = arguments[index + 1] }
                else { data = arguments[index + 1] }
                index += 2
            } else { index += 1 }
        }
        webRoot = web.map { URL(fileURLWithPath: $0, isDirectory: true).standardizedFileURL }
            ?? Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
        dataDirectory = Self.profileDirectory(explicitPath: data, applicationSupportDirectory:
            applicationSupportDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
    }

    static func profileDirectory(explicitPath: String?, applicationSupportDirectory: URL) -> URL {
        if let explicitPath {
            return URL(fileURLWithPath: explicitPath, isDirectory: true).standardizedFileURL
        }
        let legacy = applicationSupportDirectory.appendingPathComponent("Mori", isDirectory: true)
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: legacy.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return legacy
        }
        return applicationSupportDirectory.appendingPathComponent("Inkleaf", isDirectory: true)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windows: [MoriWindowController] = []
    private var menus: Menus?
    private var options: LaunchOptions?
    private var askingToQuit=false
    private var windowSessions:WindowSessionStore?
    private var settingsStore:SettingsStore?
    private let appIconController = AppIconController()
    private var startupComplete=false
    private var queuedOpenFiles:[String]=[]

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let options = try LaunchOptions()
            self.options = options
            menus = Menus { [weak self] command in self?.send(command) }
            menus?.install()
            let sessions=WindowSessionStore(dataDirectory:options.dataDirectory);windowSessions=sessions;settingsStore=SettingsStore(dataDirectory:options.dataDirectory)
            Task{@MainActor [weak self] in
                guard let self else{return}
                do{let preferences=try await settingsStore?.all() ?? [:]
                    appIconController.apply(settings:preferences)
                    let saved=preferences["restoreSession"] == .bool(false) ? []:try await sessions.all(),migrate=await !sessions.hasSavedState()
                    if saved.isEmpty{newWindow(inheritLegacy:migrate)}else{for record in saved{newWindow(restored:record)}}
                }catch{newWindow();let alert=NSAlert(error:error);if let window=windows.first?.window{await alert.beginSheetModal(for:window)}}
                startupComplete=true;for path in queuedOpenFiles{windows.last?.enqueueOpen(path)};queuedOpenFiles=[]
                NSApplication.shared.activate(ignoringOtherApps:true)
            }
        } catch { NSAlert(error: error).runModal(); NSApplication.shared.terminate(nil) }
    }
    private func newWindow(restored:WindowSession?=nil,inheritLegacy:Bool=false) {
        guard let options else { return }
        let controller = MoriWindowController(options:options,windowSessions:windowSessions,settings:settingsStore,restored:restored,inheritLegacySession:inheritLegacy)
        controller.onClose = { [weak self, weak controller] in
            self?.windows.removeAll { $0 === controller }
        }
        windows.append(controller)
        controller.showWindow(nil)
    }
    private func send(_ command: NativeCommand) {
        if command.type == "newWindow" { newWindow(); return }
        let controller = windows.first { $0.window === NSApplication.shared.keyWindow } ?? windows.last
        if command.type == "nativePrint" { controller?.printDocument(); return }
        controller?.bridge.command(command)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender:NSApplication)->NSApplication.TerminateReply{
        if askingToQuit{return .terminateCancel};askingToQuit=true
        Task{@MainActor [weak self] in
            guard let self else{sender.reply(toApplicationShouldTerminate:true);return}
            let quittingWindows=windows
            for controller in quittingWindows{if !(await controller.prepareToClose(reason:"quit")){askingToQuit=false;sender.reply(toApplicationShouldTerminate:false);return};do{try await controller.bridge.persistWindowFrame()}catch{askingToQuit=false;NSAlert(error:error).runModal();sender.reply(toApplicationShouldTerminate:false);return}}
            // An earlier window may receive input while another window's recovery dialog is open.
            for controller in quittingWindows {
                guard await controller.closeApprovalIsCurrent(reason:"quit") else {askingToQuit=false;sender.reply(toApplicationShouldTerminate:false);return}
            }
            guard windows.count==quittingWindows.count,quittingWindows.allSatisfy({candidate in windows.contains{$0===candidate}}) else {
                askingToQuit=false;sender.reply(toApplicationShouldTerminate:false);return
            }
            sender.reply(toApplicationShouldTerminate:true)
        };return .terminateLater
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && startupComplete { newWindow() }
        return true
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        if !startupComplete{queuedOpenFiles.append(contentsOf:filenames);sender.reply(toOpenOrPrint:.success);return}
        if windows.isEmpty { newWindow() }
        for filename in filenames { windows.last?.enqueueOpen(filename) }
        sender.reply(toOpenOrPrint: .success)
    }
}
