import Foundation

/// Recovery files have stable IDs, so window-local stores must agree on their live owner.
final class RecoveryOwnership: @unchecked Sendable {
    static let shared = RecoveryOwnership()
    private let lock = NSLock()
    private var owners: [String: UUID] = [:]

    func claim(_ path: String, owner: UUID) -> Bool {
        lock.withLock {
            if let current = owners[path], current != owner { return false }
            owners[path] = owner
            return true
        }
    }

    func release(_ path: String, owner: UUID) {
        lock.withLock { if owners[path] == owner { owners.removeValue(forKey: path) } }
    }

    func releaseAll(owner: UUID) {
        lock.withLock { owners = owners.filter { $0.value != owner } }
    }
}
