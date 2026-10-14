import Foundation

public struct ToolResult: Codable, Sendable {
    public var stdout: String = ""
    public var stderr: String = ""
    public var exitCode: Int32 = 0
    public var cancelled: Bool = false
    public var timedOut: Bool = false
    public var outputTruncated: Bool = false
    public var duration: Double = 0
}

public enum ProcessRunnerError: Error, Sendable {
    case missingExecutable(String)
    case invalidJob(String)
    case launchFailed(String)
}

public actor ProcessRunner {
    private var jobs: [String: RunningProcess] = [:]
    public init() {}
    public func run(jobId: String, executable: String, arguments: [String], input: String? = nil,
                    directory: String? = nil, timeout: Double = 60, maxOutputBytes: Int = 8_388_608) async throws -> ToolResult {
        guard !jobId.isEmpty, jobs[jobId] == nil else { throw ProcessRunnerError.invalidJob(jobId) }
        guard executable.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: executable) else {
            throw ProcessRunnerError.missingExecutable(executable)
        }
        let state = RunningProcess(executable: executable, arguments: arguments, directory: directory,
                                   limit: max(0, maxOutputBytes))
        jobs[jobId] = state
        defer { jobs.removeValue(forKey: jobId) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.start(input: input, timeout: max(0.01, timeout), continuation: continuation)
            }
        } onCancel: { state.stop(timedOut: false) }
    }
    @discardableResult public func cancel(jobId: String)->Bool{guard let state=jobs[jobId] else{return false};state.stop(timedOut:false);return true}
}

private final class RunningProcess: @unchecked Sendable {
    private let process = Process()
    private let output = Pipe(), errors = Pipe(), input = Pipe()
    private let lock = NSLock(), readers = DispatchGroup()
    private var stdout = Data(), stderr = Data()
    private var truncated = false, cancelled = false, timedOut = false
    private let limit: Int
    private let started = Date()
    private var deadline: DispatchWorkItem?

    init(executable: String, arguments: [String], directory: String?, limit: Int) {
        self.limit = limit
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let directory { process.currentDirectoryURL = URL(fileURLWithPath: directory, isDirectory: true) }
        process.standardOutput = output; process.standardError = errors; process.standardInput = input
    }

    func start(input text: String?, timeout: Double, continuation: CheckedContinuation<ToolResult, Error>) {
        readers.enter(); readers.enter(); readers.enter()
        process.terminationHandler = { [self] child in
            deadline?.cancel()
            readers.notify(queue: .global(qos: .userInitiated)) { [self] in
                lock.lock()
                let result = ToolResult(stdout: String(decoding: stdout, as: UTF8.self),
                                        stderr: String(decoding: stderr, as: UTF8.self),
                                        exitCode: child.terminationStatus, cancelled: cancelled,
                                        timedOut: timedOut, outputTruncated: truncated,
                                        duration: Date().timeIntervalSince(started))
                lock.unlock()
                child.terminationHandler = nil
                continuation.resume(returning: result)
            }
        }
        do { try process.run() }
        catch {
            process.terminationHandler = nil
            readers.leave(); readers.leave(); readers.leave()
            continuation.resume(throwing: ProcessRunnerError.launchFailed(error.localizedDescription)); return
        }
        for (handle, isError) in [(output.fileHandleForReading, false), (errors.fileHandleForReading, true)] {
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                defer { try? handle.close(); readers.leave() }
                while let data = try? handle.read(upToCount: 65_536), !data.isEmpty {
                    lock.lock()
                    if isError {
                        let remaining = max(0, limit - stderr.count)
                        stderr.append(data.prefix(remaining)); if data.count > remaining { truncated = true }
                    } else {
                        let remaining = max(0, limit - stdout.count)
                        stdout.append(data.prefix(remaining)); if data.count > remaining { truncated = true }
                    }
                    lock.unlock()
                }
            }
        }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { try? input.fileHandleForWriting.close(); readers.leave() }
            if let text { try? input.fileHandleForWriting.write(contentsOf: Data(text.utf8)) }
        }
        let timer = DispatchWorkItem { [weak self] in self?.stop(timedOut: true) }
        deadline = timer
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
    }

    func stop(timedOut timeout: Bool) {
        lock.lock()
        if timeout { timedOut = true } else { cancelled = true }
        let running = process.isRunning
        lock.unlock()
        guard running else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, self.process.isRunning else { return }
            kill(self.process.processIdentifier, SIGKILL)
        }
    }
}
