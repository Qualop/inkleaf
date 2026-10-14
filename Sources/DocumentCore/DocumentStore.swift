import Foundation

public struct DocumentObservation: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case unchanged, modified, missing
    }
    public let status: Status
    public let diskDigest: String?

    private enum CodingKeys: String, CodingKey { case status, diskDigest }
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(diskDigest, forKey: .diskDigest)
    }
}

public actor DocumentStore {
    private struct Record: Codable {
        var snapshot: DocumentSnapshot
        var hasBOM: Bool
    }
    private let dataDirectory: URL
    private let recoveryOwner = UUID()
    private var records: [String: Record] = [:]
    private var recoveryDirectory: URL { dataDirectory.appendingPathComponent("recoveries", isDirectory: true) }

    public init(dataDirectory: URL) { self.dataDirectory = dataDirectory }
    deinit { RecoveryOwnership.shared.releaseAll(owner: recoveryOwner) }
    public func updateFormat(id:String,text:String,revision:Int,encoding:String)throws->DocumentSnapshot{
        guard ["utf8","utf8bom","utf16le","utf16be"].contains(encoding) else{throw DocumentError.invalidEncoding(encoding)}
        var record=try checkedRecord(id:id,revision:revision)
        let bom=encoding != "utf8"
        _=try TextCodec.encode(text,encoding:encoding,hasBOM:bom)
        record.snapshot.text=text;record.snapshot.revision=revision;record.snapshot.encoding=encoding
        record.snapshot.lineEnding=TextCodec.lineEnding(text);record.hasBOM=bom
        records[id]=record;return record.snapshot
    }

    public func create(text: String = "") -> DocumentSnapshot {
        let snapshot = DocumentSnapshot(documentId: UUID().uuidString, path: nil, text: text,
                                        revision: 0, savedDigest: nil, encoding: "utf8",
                                        lineEnding: TextCodec.lineEnding(text))
        records[snapshot.documentId] = Record(snapshot: snapshot, hasBOM: false)
        _ = RecoveryOwnership.shared.claim(recoveryKey(id: snapshot.documentId), owner: recoveryOwner)
        return snapshot
    }

    public func open(path: String) throws -> DocumentSnapshot {
        let url = try FileIO.url(path)
        let bytes = try FileIO.read(url)
        let decoded = try TextCodec.decode(bytes, path: url.path)
        let snapshot = DocumentSnapshot(documentId: UUID().uuidString, path: url.path, text: decoded.text,
                                        revision: 0, savedDigest: FileIO.digest(bytes), encoding: decoded.encoding,
                                        lineEnding: TextCodec.lineEnding(decoded.text))
        records[snapshot.documentId] = Record(snapshot: snapshot, hasBOM: decoded.hasBOM)
        _ = RecoveryOwnership.shared.claim(recoveryKey(id: snapshot.documentId), owner: recoveryOwner)
        return snapshot
    }

    public func rebind(id:String,path:String?) throws -> DocumentSnapshot {
        guard var record=records[id] else {throw DocumentError.unknownDocument(id)}
        if let path {
            record.snapshot.path=try FileIO.url(path).path
        } else {record.snapshot.path=nil;record.snapshot.savedDigest=nil}
        records[id]=record;return record.snapshot
    }
    public func verifySaved(id:String) throws -> DocumentSnapshot {
        guard let record=records[id] else {throw DocumentError.unknownDocument(id)}
        guard let path=record.snapshot.path else {throw DocumentError.invalidPath("Document has no saved file")}
        let bytes=try FileIO.read(FileIO.url(path))
        guard FileIO.digest(bytes)==record.snapshot.savedDigest else {throw DocumentError.conflict(path)}
        return record.snapshot
    }

    public func observe(id: String) throws -> DocumentObservation {
        guard let record = records[id] else { throw DocumentError.unknownDocument(id) }
        guard let path = record.snapshot.path else { return DocumentObservation(status: .unchanged, diskDigest: nil) }
        do {
            let digest = try FileIO.diskDigest(FileIO.url(path, resolveSymlinks: false))
            return DocumentObservation(status: digest == record.snapshot.savedDigest ? .unchanged : .modified, diskDigest: digest)
        } catch DocumentError.missing {
            return DocumentObservation(status: .missing, diskDigest: nil)
        }
    }

    public func reload(id: String, revision: Int) throws -> DocumentSnapshot {
        var record = try checkedRecord(id: id, revision: revision)
        guard let path = record.snapshot.path else { throw DocumentError.invalidPath("Untitled document has no disk version") }
        let url = try FileIO.url(path), bytes = try FileIO.read(url)
        let decoded = try TextCodec.decode(bytes, path: path)
        record.snapshot.text = decoded.text; record.snapshot.revision = revision
        record.snapshot.savedDigest = FileIO.digest(bytes); record.snapshot.encoding = decoded.encoding
        record.snapshot.lineEnding = TextCodec.lineEnding(decoded.text); record.hasBOM = decoded.hasBOM
        try removeRecovery(id: id); records[id] = record
        return record.snapshot
    }

    public func save(id: String, text: String, revision: Int, force: Bool = false,
                     expectedDigest: String? = nil, enforceExpectedDigest: Bool = false) throws -> DocumentSnapshot {
        var record = try checkedRecord(id: id, revision: revision)
        guard let path = record.snapshot.path else { throw DocumentError.invalidPath("Document \(id) needs a save destination") }
        guard force || !enforceExpectedDigest || expectedDigest == record.snapshot.savedDigest else {
            throw DocumentError.conflict(path)
        }
        let url = try FileIO.url(path)
        let bytes = try TextCodec.encode(text, encoding: record.snapshot.encoding, hasBOM: record.hasBOM)
        let originalDigest = record.snapshot.savedDigest
        let check: () throws -> Void = {
            guard !force else { return }
            do {
                let disk = try FileIO.read(url)
                guard FileIO.digest(disk) == originalDigest else { throw DocumentError.conflict(path) }
            } catch DocumentError.missing { throw DocumentError.conflict(path) }
        }
        try check()
        try FileIO.write(bytes, to: url, beforeCommit: check)
        record.snapshot.text = text
        record.snapshot.revision = revision
        record.snapshot.savedDigest = FileIO.digest(bytes)
        record.snapshot.lineEnding = TextCodec.lineEnding(text)
        records[id] = record
        try removeRecovery(id: id)
        return record.snapshot
    }

    public func saveAs(id: String, path: String, text: String, revision: Int, overwrite: Bool = false, assetRoot: String? = nil, imageReferences: [DocumentAssetReference] = []) throws -> DocumentSnapshot {
        var record = try checkedRecord(id: id, revision: revision)
        let url = try FileIO.url(path)
        // Saving to the document's existing path still observes its base digest.
        if record.snapshot.path == url.path {
            return try save(id: id, text: text, revision: revision, force: overwrite)
        }
        let publication = try AssetPublication.prepare(text: text, root: assetRoot, destination: url, references: imageReferences)
        do {
            let bytes = try TextCodec.encode(publication.text, encoding: record.snapshot.encoding, hasBOM: record.hasBOM)
            try FileIO.write(bytes, to: url, overwrite: overwrite)
            record.snapshot.savedDigest = FileIO.digest(bytes)
        } catch { try AssetPublication.rollback(publication.created, because: error); throw error }
        record.snapshot.path = url.path
        record.snapshot.text = publication.text
        record.snapshot.revision = revision
        record.snapshot.lineEnding = TextCodec.lineEnding(publication.text)
        records[id] = record
        try removeRecovery(id: id)
        return record.snapshot
    }

    public func checkpoint(id: String, text: String, revision: Int) throws {
        var record = try checkedRecord(id: id, revision: revision)
        record.snapshot.text = text
        record.snapshot.revision = revision
        record.snapshot.lineEnding = TextCodec.lineEnding(text)
        let bytes = try TextCodec.encode(text, encoding: record.snapshot.encoding, hasBOM: record.hasBOM)
        if record.snapshot.savedDigest == FileIO.digest(bytes) {
            try removeRecovery(id: id)
        } else {
            try FileIO.directory(recoveryDirectory, create: true)
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                try FileIO.write(encoder.encode(record), to: recoveryURL(id: id))
            } catch { throw FileIO.mapped(error, path: recoveryDirectory.path) }
        }
        records[id] = record
    }

    public func recoveries() throws -> [DocumentSnapshot] {
        guard FileManager.default.fileExists(atPath: recoveryDirectory.path) else { return [] }
        do {
            let files = try FileManager.default.contentsOfDirectory(at: recoveryDirectory, includingPropertiesForKeys: nil)
            return try files.filter { $0.pathExtension == "json" }.map { try readRecovery(at: $0).snapshot }
                .sorted { $0.documentId < $1.documentId }
        } catch { throw FileIO.mapped(error, path: recoveryDirectory.path) }
    }

    public func restore(id: String) throws -> DocumentSnapshot {
        let alreadyOpen = records[id] != nil
        let key = recoveryKey(id: id)
        guard RecoveryOwnership.shared.claim(key, owner: recoveryOwner) else { throw DocumentError.conflict(id) }
        do {
            let record = try readRecovery(at: recoveryURL(id: id))
            guard record.snapshot.documentId == id else { throw DocumentError.io("Recovery identity mismatch: \(id)") }
            if let current = records[id], current.snapshot.revision > record.snapshot.revision { throw DocumentError.conflict(id) }
            records[id] = record
            return record.snapshot
        } catch {
            if !alreadyOpen { RecoveryOwnership.shared.release(key, owner: recoveryOwner) }
            throw error
        }
    }

    /// Clean session entries have no recovery. Keep their stable ID while reading current disk bytes.
    public func restoreSession(id:String,path:String?) throws -> DocumentSnapshot {
        if let current=records[id] {return current.snapshot}
        do {return try restore(id:id)}
        catch DocumentError.missing {
            guard let path else {throw DocumentError.missing(recoveryURL(id:id).path)}
            guard !id.isEmpty,id.count<=128,!id.contains("\0") else{throw DocumentError.invalidPath("Invalid session document identity.")}
            let key=recoveryKey(id:id)
            guard RecoveryOwnership.shared.claim(key,owner:recoveryOwner) else{throw DocumentError.conflict(id)}
            do {
                let url=try FileIO.url(path),bytes=try FileIO.read(url),decoded=try TextCodec.decode(bytes,path:url.path)
                let snapshot=DocumentSnapshot(documentId:id,path:url.path,text:decoded.text,revision:0,savedDigest:FileIO.digest(bytes),encoding:decoded.encoding,lineEnding:TextCodec.lineEnding(decoded.text))
                records[id]=Record(snapshot:snapshot,hasBOM:decoded.hasBOM)
                return snapshot
            } catch {RecoveryOwnership.shared.release(key,owner:recoveryOwner);throw error}
        }
    }

    public func keepRecovery(id:String,revision:Int) throws -> DocumentSnapshot {
        let record=try checkedRecord(id:id,revision:revision)
        guard revision==record.snapshot.revision else{throw DocumentError.conflict(id)}
        try checkpoint(id:id,text:record.snapshot.text,revision:revision)
        return record.snapshot
    }

    public func discardRecovery(id:String) throws {
        guard records[id] != nil else{throw DocumentError.unknownDocument(id)}
        try removeRecovery(id:id)
    }

    public func close(id:String,discardRecovery:Bool,keepRevision:Int?=nil) throws {
        if let keepRevision {_ = try keepRecovery(id:id,revision:keepRevision)}
        if discardRecovery {try self.discardRecovery(id:id)}
        close(id:id)
    }

    /// Closing a document releases memory; an unsaved checkpoint remains recoverable.
    public func close(id: String) {
        records.removeValue(forKey: id)
        RecoveryOwnership.shared.release(recoveryKey(id: id), owner: recoveryOwner)
    }

    /// Release all live documents without changing their persisted recovery snapshots.
    public func closeAll() {
        records.removeAll()
        RecoveryOwnership.shared.releaseAll(owner: recoveryOwner)
    }

    private func checkedRecord(id: String, revision: Int) throws -> Record {
        guard let record = records[id] else { throw DocumentError.unknownDocument(id) }
        guard revision >= 0, revision >= record.snapshot.revision else { throw DocumentError.conflict(id) }
        return record
    }

    private func recoveryURL(id: String) -> URL {
        recoveryDirectory.appendingPathComponent(FileIO.digest(Data(id.utf8)) + ".json")
    }

    private func recoveryKey(id: String) -> String {
        recoveryURL(id: id).standardizedFileURL.resolvingSymlinksInPath().path
    }

    private func readRecovery(at url: URL) throws -> Record {
        do {
            let record = try JSONDecoder().decode(Record.self, from: FileIO.read(url))
            guard record.snapshot.revision >= 0, !record.snapshot.documentId.isEmpty,
                  ["utf8", "utf8bom", "utf16le", "utf16be"].contains(record.snapshot.encoding) else {
                throw DocumentError.io("Invalid recovery: \(url.path)")
            }
            return record
        } catch { throw FileIO.mapped(error, path: url.path) }
    }

    private func removeRecovery(id: String) throws {
        let url = recoveryURL(id: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do { try FileManager.default.removeItem(at: url) }
        catch { throw FileIO.mapped(error, path: url.path) }
    }
}
