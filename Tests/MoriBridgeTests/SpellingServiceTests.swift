import AppKit
import WebKit
import XCTest
import DocumentCore
@testable import Mori

@MainActor
final class SpellingServiceTests: XCTestCase {
    func testBareDweyoHasAnExplicitCorrection() async {
        let checked=SpellingService.koreanIssues(text:"되요. 돼요.",ignoredWords:[])
        XCTAssertEqual(checked.count,1)
        XCTAssertEqual(checked.first?.suggestions,["돼요"])
    }
    func testLocalDictionaryDefinitionDoesNotRequireAVisibleView() async throws {
        let value=try await SpellingService().lookup(text:"apple",in:WKWebView())
        guard case .object(let result)=value,case .string(let definition)=result["definition"] else{return XCTFail("Missing local dictionary definition")}
        XCTAssertEqual(result["provider"],.string("macOS local dictionary"))
        if definition.isEmpty {throw XCTSkip("No installed dictionary defines apple")}
        XCTAssertGreaterThan(definition.count,20)
    }
    private func issues(_ value: JSONValue) -> [[String: JSONValue]] {
        guard case .object(let object) = value, case .array(let values) = object["issues"] else { return [] }
        return values.compactMap { if case .object(let issue) = $0 { return issue }; return nil }
    }
    func testKoreanCommonSpellingAndSpacingWithUTF16Offsets() async {
        let text = "😀 시작\r\n설겆이를 했어요. 됬어요. 오랫만에 할수있어요."
        let checked = SpellingService.koreanIssues(text: text, ignoredWords: [])
        XCTAssertEqual(checked.map { (text as NSString).substring(with: NSRange(location: $0.from, length: $0.to - $0.from)) }, ["설겆이를", "됬어요", "오랫만에", "할수있어요"])
        XCTAssertEqual(checked.map { $0.suggestions.first! }, ["설거지를", "됐어요", "오랜만에", "할 수 있어요"])
        XCTAssertEqual(checked.map { $0.kind }, ["spelling", "spelling", "spelling", "grammar"])
    }
    func testKoreanRulesAvoidFalseWordMatchesAndRespectPersonalDictionary() async {
        XCTAssertTrue(SpellingService.koreanIssues(text: "왠지 웬일 오랜만에 설거지를 했어요. 됐어요. 할 수 있어요. 안타까웬지 프로젝트할수있어요 몇일정표", ignoredWords: []).isEmpty)
        XCTAssertTrue(SpellingService.koreanIssues(text: "됬어요", ignoredWords: ["됬어요"]).isEmpty)
        XCTAssertEqual(SpellingService.koreanIssues(text: "웬지 왠일 몇일 어떻해", ignoredWords: []).map { $0.suggestions.first! }, ["왠지", "웬일", "며칠", "어떡해"])
    }
    func testMarkdownMaskRetainsOffsetsAndChecksOnlyProse() async {
        let text = "---\r\ntitle: 됬어요\r\n---\r\n# 됬어요\r\n`됬어요` https://test.invalid/됬어요 [됬어요](설겆이)\r\n```js\r\n됬어요\r\n```\r\n    됬어요\r\n<span class=\"됬어요\">설겆이</span> $됬어요$"
        let mask = SpellingService.proseText(text)
        XCTAssertEqual(mask.utf16.count, text.utf16.count)
        XCTAssertEqual(SpellingService.koreanIssues(text: mask, ignoredWords: []).map { $0.suggestions.first! }, ["됐어요", "됐어요", "설거지"])
    }
    func testMarkdownMaskExcludesQuotedFencesAndReferenceIdentifiers() async {
        let text = "[정상][됬어요]\n\n[됬어요]: https://example.invalid\n\n> ```js\n> 됬어요\n> ```\n\nftp://example.invalid/됬어요\n\n됬어요"
        let checked = SpellingService.koreanIssues(text: SpellingService.proseText(text), ignoredWords: [])
        XCTAssertEqual(checked.count, 1)
        XCTAssertEqual(checked.first?.from, (text as NSString).range(of: "됬어요", options: .backwards).location)
    }
    func testActualInstalledCheckerReportsLanguagesAndEnglishSuggestion() async throws {
        let service = SpellingService()
        let value = service.check(text: "😀 This is mispeling.", language: "en", ignoredWords: [])
        guard case .object(let object) = value, case .array(let languages) = object["languages"] else { return XCTFail("missing available languages") }
        XCTAssertTrue(languages.contains(.string("en")))
        let issue = try XCTUnwrap(issues(value).first)
        XCTAssertEqual(issue["from"], .number(11)); XCTAssertEqual(issue["to"], .number(20))
        guard case .array(let suggestions) = issue["suggestions"] else { return XCTFail("missing suggestions") }
        XCTAssertTrue(suggestions.contains(.string("misspelling")))
        XCTAssertTrue(issues(service.check(text: "mispeling", language: "en", ignoredWords: ["mispeling"])).isEmpty)
        XCTAssertFalse(issues(service.check(text: "mispeling", language: "en", ignoredWords: [])).isEmpty, "App ignore list must not persist in the system checker")
    }
    func testDictionaryCheckExcludesMarkdownAndNeverFallsBackToAnotherLanguage() async {
        let service = SpellingService()
        let text = "😀 mispeling\r\n`mispeling` [label](mispeling)\r\n```\r\nmispeling\r\n```"
        let checked = issues(service.check(text: text, language: "en", ignoredWords: []))
        XCTAssertEqual(checked.filter { $0["kind"] == .string("spelling") }.count, 1)
        XCTAssertEqual(checked.first?["from"], .number(3))
        let unavailable = service.check(text: "mispeling", language: "zz-unavailable", ignoredWords: [])
        XCTAssertTrue(issues(unavailable).isEmpty)
        guard case .object(let object) = unavailable else { return XCTFail("missing result") }
        XCTAssertEqual(object["language"], .string("zz-unavailable"))
        XCTAssertNotNil(object["note"])
    }
    func testActualKoreanCheckerAndBoundedResult() async throws {
        let service = SpellingService()
        guard NSSpellChecker.shared.availableLanguages.contains("ko") else { throw XCTSkip("Korean system checker is not installed") }
        let value = service.check(text: "설겆이를 했어요. 할수있어요.", language: "ko", ignoredWords: [])
        XCTAssertTrue(issues(value).contains { $0["kind"] == .string("spelling") })
        XCTAssertTrue(issues(value).contains { $0["kind"] == .string("grammar") })
        XCTAssertLessThanOrEqual(issues(service.check(text: Array(repeating: "됬어요", count: 400).joined(separator: " "), language: "ko", ignoredWords: [])).count, 200)
    }
}
