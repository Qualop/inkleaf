import Foundation
import CoreGraphics
import ImageIO
import XCTest
@testable import DocumentCore

@MainActor
final class AssetAliasSaveTests: XCTestCase {
    private func fixture() throws -> (root: URL, actual: URL, alias: URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("InkleafAssetAlias-\(UUID().uuidString)").resolvingSymlinksInPath()
        let actual = root.appendingPathComponent("physical"), alias = root.appendingPathComponent("alias")
        try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: actual)
        return (root.resolvingSymlinksInPath(), actual.resolvingSymlinksInPath(), alias)
    }
    private func png(red: Bool) throws -> Data {
        let pixels = Data(red ? [255, 0, 0, 255] : [0, 255, 0, 255])
        let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
        let image = try XCTUnwrap(CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let result = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(result, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let decoded = try XCTUnwrap(CGImageSourceCreateWithData(result, nil))
        XCTAssertNotNil(CGImageSourceCreateImageAtIndex(decoded, 0, nil), "The fixture must be a real decodable PNG")
        return result as Data
    }
    private let text = "😀 ![probe](assets/probe.png)\r\n한국어 문서"
    private func reference(_ image: URL) -> [DocumentAssetReference] {
        let range = (text as NSString).range(of: "assets/probe.png")
        return [DocumentAssetReference(path: image.path, from: range.location, to: NSMaxRange(range))]
    }

    func testSameFolderSaveAsThroughAliasedParentKeepsImageAndLinks() async throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let assets = files.actual.appendingPathComponent("assets")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        let image = assets.appendingPathComponent("probe.png"), imageBytes = try png(red: true)
        try imageBytes.write(to: image)
        let original = files.actual.appendingPathComponent("Inkleaf Mac Audit.md")
        try Data(text.utf8).write(to: original)
        let store = DocumentStore(dataDirectory: files.root.appendingPathComponent("state"))
        let opened = try await store.open(path: files.alias.appendingPathComponent(original.lastPathComponent).path)
        for (index, source) in [files.actual, files.alias].enumerated() {
            let copy = files.alias.appendingPathComponent("Audit Copy \(index).md")
            let declared = try FileIO.url(source.path)
            let parent = try FileIO.url(copy.path).deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
            print("ASSET_ALIAS same-folder \(index) source=\(declared.absoluteString) target=\(parent.absoluteString) urlEqual=\(declared == parent) pathEqual=\(declared.pathComponents == parent.pathComponents)")
            let saved = try await store.saveAs(id: opened.documentId, path: copy.path, text: text, revision: index + 1,
                assetRoot: source.path, imageReferences: reference(files.alias.appendingPathComponent("assets/probe.png")))
            XCTAssertEqual(saved.text, text)
            XCTAssertEqual(try Data(contentsOf: copy), Data(text.utf8))
            XCTAssertEqual(try Data(contentsOf: original), Data(text.utf8))
            XCTAssertEqual(try Data(contentsOf: image), imageBytes)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: assets.path), ["probe.png"], "A same-folder Save As must not create duplicate image copies")
        }
        let occupied = files.alias.appendingPathComponent("occupied.md"), sentinel = Data("unrelated existing document".utf8)
        try sentinel.write(to: occupied)
        do {
            _ = try await store.saveAs(id: opened.documentId, path: occupied.path, text: text, revision: 3,
                assetRoot: files.alias.path, imageReferences: reference(image))
            XCTFail("An alias must not bypass the no-overwrite document boundary")
        } catch let error as DocumentError { XCTAssertEqual(error.code, "conflict") }
        XCTAssertEqual(try Data(contentsOf: occupied), sentinel)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: assets.path), ["probe.png"])
    }

    func testCrossFolderSaveAsThroughAliasedParentPublishesAndRollsBackCollisions() async throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let source = files.actual.appendingPathComponent("source"), target = files.actual.appendingPathComponent("copies")
        try FileManager.default.createDirectory(at: source.appendingPathComponent("assets"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: target.appendingPathComponent("assets"), withIntermediateDirectories: true)
        let image = source.appendingPathComponent("assets/probe.png"), existing = target.appendingPathComponent("assets/probe.png")
        let sourceBytes = try png(red: true), existingBytes = try png(red: false)
        try sourceBytes.write(to: image); try existingBytes.write(to: existing)
        let store = DocumentStore(dataDirectory: files.root.appendingPathComponent("state")), draft = await store.create(text: text)
        let destination = files.alias.appendingPathComponent("copies/Audit Copy.md")
        let saved = try await store.saveAs(id: draft.documentId, path: destination.path, text: text, revision: 1,
            assetRoot: files.alias.appendingPathComponent("source").path, imageReferences: reference(image))
        let expected = "😀 ![probe](assets/probe-1.png)\r\n한국어 문서"
        XCTAssertEqual(saved.text, expected)
        XCTAssertEqual(try Data(contentsOf: destination), Data(expected.utf8))
        XCTAssertEqual(try Data(contentsOf: target.appendingPathComponent("assets/probe-1.png")), sourceBytes)
        XCTAssertEqual(try Data(contentsOf: existing), existingBytes); XCTAssertEqual(try Data(contentsOf: image), sourceBytes)
        let occupied = files.alias.appendingPathComponent("copies/existing.md"), sentinel = Data("occupied".utf8)
        try sentinel.write(to: occupied)
        do {
            _ = try await store.saveAs(id: draft.documentId, path: occupied.path, text: text, revision: 2,
                assetRoot: source.path, imageReferences: reference(image))
            XCTFail("Must preserve an occupied document and roll back only new asset copies")
        } catch let error as DocumentError { XCTAssertEqual(error.code, "conflict") }
        XCTAssertEqual(try Data(contentsOf: occupied), sentinel)
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: target.appendingPathComponent("assets").path)), ["probe.png", "probe-1.png"])
        XCTAssertEqual(try Data(contentsOf: existing), existingBytes)
    }

    func testAliasedDestinationStillRejectsEscapingAssetsDirectory() async throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let source = files.actual.appendingPathComponent("source"), target = files.actual.appendingPathComponent("target"), outside = files.root.appendingPathComponent("outside")
        for directory in [source.appendingPathComponent("assets"), target, outside] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        let image = source.appendingPathComponent("assets/probe.png"), imageBytes = try png(red: true)
        try imageBytes.write(to: image)
        try FileManager.default.createSymbolicLink(at: target.appendingPathComponent("assets"), withDestinationURL: outside)
        let store = DocumentStore(dataDirectory: files.root.appendingPathComponent("state")), document = await store.create(text: text)
        try await store.checkpoint(id: document.documentId, text: text, revision: 1)
        let destination = files.alias.appendingPathComponent("target/Audit Copy.md")
        do {
            _ = try await store.saveAs(id: document.documentId, path: destination.path, text: text, revision: 2,
                assetRoot: source.path, imageReferences: reference(image))
            XCTFail("An aliased parent must not authorize an assets symlink outside that parent")
        } catch let error as DocumentError { XCTAssertEqual(error.code, "invalidPath") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
        XCTAssertEqual(try Data(contentsOf: image), imageBytes)
        let kept = try await store.recoveries(); XCTAssertEqual(kept.first?.text, text)
    }

    func testSourceAssetSymlinkOutsideDeclaredRootRemainsRejected() async throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let source = files.actual.appendingPathComponent("source"), target = files.actual.appendingPathComponent("target"), outside = files.root.appendingPathComponent("outside")
        for directory in [source, target, outside] { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        let image = outside.appendingPathComponent("probe.png"), imageBytes = try png(red: true)
        try imageBytes.write(to: image)
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("assets"), withDestinationURL: outside)
        let store = DocumentStore(dataDirectory: files.root.appendingPathComponent("state")), document = await store.create(text: text)
        let destination = files.alias.appendingPathComponent("target/Copy.md")
        do {
            _ = try await store.saveAs(id: document.documentId, path: destination.path, text: text, revision: 1,
                assetRoot: files.alias.appendingPathComponent("source").path, imageReferences: reference(source.appendingPathComponent("assets/probe.png")))
            XCTFail("Must not publish an asset outside its declared source root")
        } catch let error as DocumentError { XCTAssertEqual(error.code, "invalidPath") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertEqual(try Data(contentsOf: image), imageBytes)
    }

    func testPublicationCanonicalizesParentWithoutFollowingDestinationLeaf() throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let source = files.actual.appendingPathComponent("source"), target = files.actual.appendingPathComponent("target"), outside = files.root.appendingPathComponent("outside")
        for directory in [source.appendingPathComponent("assets"), target, outside] { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
        let image = source.appendingPathComponent("assets/probe.png"), imageBytes = try png(red: true)
        try imageBytes.write(to: image)
        let foreign = outside.appendingPathComponent("existing.md"), sentinel = Data("foreign document".utf8)
        try sentinel.write(to: foreign)
        let destination = files.alias.appendingPathComponent("target/selected.md")
        try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: foreign)
        let publication = try AssetPublication.prepare(text: text, root: source.path, destination: destination, references: reference(image))
        XCTAssertEqual(publication.text, text)
        XCTAssertEqual(publication.created.map { $0.deletingLastPathComponent().path }, [target.appendingPathComponent("assets").path])
        try FileIO.write(Data(publication.text.utf8), to: destination, overwrite: true)
        XCTAssertEqual(try Data(contentsOf: foreign), sentinel, "Publication must not resolve the selected filename to another parent")
        XCTAssertEqual(try Data(contentsOf: destination), Data(text.utf8))
        XCTAssertEqual(try Data(contentsOf: target.appendingPathComponent("assets/probe.png")), imageBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("assets").path))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: destination.path)[.type]) as? FileAttributeType, .typeRegular)
    }

    func testSystemVarAndPrivateVarParentsSupportSameAndCrossFolderSaveAs() async throws {
        let files = try fixture(); defer { try? FileManager.default.removeItem(at: files.root) }
        let actualPath = files.actual.path
        let varPath = actualPath.hasPrefix("/private/var/") ? String(actualPath.dropFirst("/private".count)) : actualPath
        guard varPath.hasPrefix("/var/"), FileManager.default.fileExists(atPath: "/private" + varPath) else {
            throw XCTSkip("Temporary directory is not accessible through the macOS /var and /private/var aliases")
        }
        let varRoot = URL(fileURLWithPath: varPath, isDirectory: true), privateRoot = URL(fileURLWithPath: "/private" + varPath, isDirectory: true)
        let assets = files.actual.appendingPathComponent("assets")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        let image = assets.appendingPathComponent("probe.png"), imageBytes = try png(red: true)
        try imageBytes.write(to: image)
        let original = files.actual.appendingPathComponent("Inkleaf Mac Audit.md")
        try Data(text.utf8).write(to: original)
        for (index, roots) in [(privateRoot, varRoot), (varRoot, privateRoot)].enumerated() {
            let (sourceRoot, destinationRoot) = roots
            let store = DocumentStore(dataDirectory: files.root.appendingPathComponent("state-\(index)"))
            let opened = try await store.open(path: sourceRoot.appendingPathComponent(original.lastPathComponent).path)
            let sameFolder = destinationRoot.appendingPathComponent("Audit Copy \(index).md")
            let saved = try await store.saveAs(id: opened.documentId, path: sameFolder.path, text: text, revision: 1,
                assetRoot: sourceRoot.path, imageReferences: reference(sourceRoot.appendingPathComponent("assets/probe.png")))
            XCTAssertEqual(saved.text, text); XCTAssertEqual(try Data(contentsOf: sameFolder), Data(text.utf8))
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: assets.path), ["probe.png"])
            let other = destinationRoot.appendingPathComponent("copies-\(index)")
            try FileManager.default.createDirectory(at: other.appendingPathComponent("assets"), withIntermediateDirectories: true)
            let crossFolder = other.appendingPathComponent("Audit Copy.md")
            let copied = try await store.saveAs(id: opened.documentId, path: crossFolder.path, text: text, revision: 2,
                assetRoot: sourceRoot.path, imageReferences: reference(image))
            XCTAssertEqual(copied.text, text); XCTAssertEqual(try Data(contentsOf: crossFolder), Data(text.utf8))
            XCTAssertEqual(try Data(contentsOf: other.appendingPathComponent("assets/probe.png")), imageBytes)
            XCTAssertEqual(try Data(contentsOf: original), Data(text.utf8))
            print("ASSET_SYSTEM_ALIAS same/cross-folder /var/private-var direction \(index) passed")
        }
    }
}
