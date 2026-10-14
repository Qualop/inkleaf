import AppKit
import CoreServices
import WebKit
import DocumentCore

@MainActor
final class SpellingService {
    struct Issue {
        let from: Int
        let to: Int
        let kind: String
        let message: String
        let suggestions: [String]
        var json: JSONValue { .object(["from": .number(Double(from)), "to": .number(Double(to)), "kind": .string(kind), "message": .string(message), "suggestions": .array(suggestions.map(JSONValue.string))]) }
    }
    private static let maximumIssues = 200
    private static let maximumText = 50_000

    func check(text: String, language: String, ignoredWords: [String]) -> JSONValue {
        let checker = NSSpellChecker.shared, languages = checker.availableLanguages
        let requested = language.replacingOccurrences(of: "_", with: "-").lowercased()
        let resolved = languages.first { $0.replacingOccurrences(of: "_", with: "-").lowercased() == requested }
            ?? languages.first { $0.replacingOccurrences(of: "_", with: "-").lowercased().components(separatedBy: "-").first == requested.components(separatedBy: "-").first }
        let original = text as NSString
        var length = min(original.length, Self.maximumText)
        if length > 0 && length < original.length && (0xD800...0xDBFF).contains(original.character(at: length - 1)) { length -= 1 }
        let mask = Self.proseText(original.substring(to: length)), source = mask as NSString
        let ignored = Set(ignoredWords.prefix(5000).map { $0.precomposedStringWithCanonicalMapping.lowercased() })
        var issues = requested.components(separatedBy: "-").first == "ko" ? Self.koreanIssues(text: mask, ignoredWords: ignoredWords) : []
        var notes: [String] = []
        if let resolved {
            let tag = NSSpellChecker.uniqueSpellDocumentTag()
            checker.setIgnoredWords(Array(ignoredWords.prefix(5000)), inSpellDocumentWithTag: tag)
            defer { checker.closeSpellDocument(withTag: tag) }
            var cursor = 0, checked = 0
            while cursor < source.length && issues.count < Self.maximumIssues && checked < 5000 {
                let range = checker.checkSpelling(of: mask, startingAt: cursor, language: resolved, wrap: false, inSpellDocumentWithTag: tag, wordCount: nil)
                guard range.location != NSNotFound, range.length > 0, range.location >= cursor, NSMaxRange(range) <= source.length else { break }
                cursor = NSMaxRange(range); checked += 1
                let word = source.substring(with: range)
                if ignored.contains(word.precomposedStringWithCanonicalMapping.lowercased()) || word.utf16.count > 100 || issues.contains(where: { $0.from < cursor && $0.to > range.location }) { continue }
                let guesses = checker.guesses(forWordRange: range, in: mask, language: resolved, inSpellDocumentWithTag: tag) ?? []
                issues.append(Issue(from: range.location, to: cursor, kind: "spelling", message: "철자를 확인하세요.", suggestions: Self.suggestions(guesses)))
            }
            var grammarCursor = 0, sentences = 0
            while grammarCursor < source.length && issues.count < Self.maximumIssues && sentences < 100 {
                var details: NSArray?
                let sentence = checker.checkGrammar(of: mask, startingAt: grammarCursor, language: resolved, wrap: false, inSpellDocumentWithTag: tag, details: &details)
                guard sentence.location != NSNotFound, sentence.length > 0, sentence.location >= grammarCursor, NSMaxRange(sentence) <= source.length else { break }
                grammarCursor = NSMaxRange(sentence); sentences += 1
                for case let detail as [String: Any] in details ?? [] {
                    guard let value = detail[NSGrammarRange] as? NSValue else { continue }
                    let relative = value.rangeValue
                    guard relative.location != NSNotFound, relative.location >= 0, relative.location <= sentence.length,
                          relative.length > 0, relative.length <= sentence.length - relative.location else { continue }
                    let from = sentence.location + relative.location, to = from + relative.length
                    guard to <= grammarCursor,
                          !issues.contains(where: { $0.from < to && $0.to > from }),
                          !ignored.contains(source.substring(with: NSRange(location: from, length: to - from)).lowercased()) else { continue }
                    let message = (detail[NSGrammarUserDescription] as? String) ?? "문법과 띄어쓰기를 확인하세요."
                    issues.append(Issue(from: from, to: to, kind: "grammar", message: String(message.prefix(500)), suggestions: Self.suggestions(detail[NSGrammarCorrections] as? [String] ?? [])))
                    if issues.count >= Self.maximumIssues { break }
                }
            }
        } else {
            notes.append(requested.hasPrefix("ko") ? "한국어 사전 검사기를 사용할 수 없어 자주 틀리는 표기와 일부 띄어쓰기만 검사합니다." : "요청한 언어의 사전 검사기를 사용할 수 없습니다.")
        }
        if original.length > length || issues.count >= Self.maximumIssues { notes.append("긴 문서는 앞부분과 최대 200개 항목을 검사합니다.") }
        var result: [String: JSONValue] = ["issues": .array(issues.sorted { $0.from == $1.from ? $0.to < $1.to : $0.from < $1.from }.prefix(Self.maximumIssues).map(\.json)), "languages": .array(languages.map(JSONValue.string)), "language": .string(resolved ?? language)]
        if !notes.isEmpty { result["note"] = .string(notes.joined(separator: " ")) }
        return .object(result)
    }

    func lookup(text: String, in view: WKWebView) async throws -> JSONValue {
        let term=text.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !term.isEmpty,term.utf16.count<=500 else{throw BridgeError.invalidRequest("Select a word or short phrase to look up.")}
        let result=DCSCopyTextDefinition(nil,term as CFString,CFRange(location:0,length:term.utf16.count))
        let definition=result?.takeRetainedValue() as String? ?? ""
        return .object(["text":.string(term),"definition":.string(definition),"available":.bool(!definition.isEmpty),"provider":.string("macOS local dictionary")])
    }

    private static func suggestions(_ words: [String]) -> [String] {
        var seen = Set<String>()
        return Array(words.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0.utf16.count <= 200 && !$0.contains("\n") && !$0.contains("\r") && seen.insert($0).inserted }.prefix(8))
    }

    static func koreanIssues(text: String, ignoredWords: [String]) -> [Issue] {
        let source = text as NSString, ignored = Set(ignoredWords.prefix(5000).map { $0.precomposedStringWithCanonicalMapping.lowercased() })
        let exact = ["되요": "돼요", "웬지": "왠지", "왠일": "웬일", "몇일": "며칠", "어떻해": "어떡해", "알맞는": "알맞은", "안되요": "안 돼요"]
        var issues: [Issue] = []
        let words = try! NSRegularExpression(pattern: "[\\p{L}\\p{M}]+(?:['’][\\p{L}\\p{M}]+)*")
        for match in words.matches(in: text, range: NSRange(location: 0,length: source.length)) {
            let word = source.substring(with: match.range)
            if ignored.contains(word.precomposedStringWithCanonicalMapping.lowercased()) { continue }
            var suggestion = exact[word]
            if suggestion == nil && word.hasPrefix("설겆이") { suggestion = word.replacingOccurrences(of: "설겆이", with: "설거지") }
            if suggestion == nil && word.hasPrefix("됬") { suggestion = word.replacingOccurrences(of: "됬", with: "됐") }
            if suggestion == nil && word == "오랫만에" { suggestion = "오랜만에" }
            if suggestion == nil && word.hasPrefix("괜찬") { suggestion = word.replacingOccurrences(of: "괜찬", with: "괜찮") }
            if let suggestion { issues.append(Issue(from: match.range.location,to: NSMaxRange(match.range),kind: "spelling",message: "한국어 표기를 확인하세요.",suggestions: [suggestion])) }
            if issues.count >= maximumIssues { break }
        }
        let spacing = try! NSRegularExpression(pattern: "(?<![\\p{L}\\p{M}])(할|될|볼|갈|올|먹을|읽을|쓸|알|만날)[ \\t]*수[ \\t]*(있|없)[가-힣]*")
        for match in spacing.matches(in: text, range: NSRange(location: 0,length: source.length)) {
            let word = source.substring(with: match.range)
            let suggestion = source.substring(with: match.range(at: 1)) + " 수 " + source.substring(with: NSRange(location: match.range(at: 2).location,length: NSMaxRange(match.range)-match.range(at: 2).location))
            if word == suggestion || ignored.contains(word.lowercased()) { continue }
            issues.append(Issue(from: match.range.location,to: NSMaxRange(match.range),kind: "grammar",message: "의존 명사 ‘수’는 앞말과 띄어 씁니다.",suggestions: [suggestion]))
            if issues.count >= maximumIssues { break }
        }
        return Array(issues.sorted { $0.from < $1.from }.prefix(maximumIssues))
    }

    static func proseText(_ text: String) -> String {
        var units = Array(text.utf16)
        func blank(_ range: NSRange) { for i in range.location..<min(NSMaxRange(range),units.count) where units[i] != 10 && units[i] != 13 { units[i] = 32 } }
        let source = text as NSString
        var offset = 0, fence: String?
        let marker = try! NSRegularExpression(pattern: "^(?:[ \\t]*>[ \\t]?)*[ \\t]*(?:(?:[-+*]|\\d+[.)])[ \\t]+)?(`{3,}|~{3,})")
        for line in text.components(separatedBy: "\n") {
            let length = (line as NSString).length, range = NSRange(location: offset,length: length)
            let match = marker.firstMatch(in: line,range: NSRange(location: 0,length: length))
            let token = match.map { (line as NSString).substring(with: $0.range(at: 1)) }
            if let current = fence {
                blank(range)
                if let token, let match, token.first == current.first, token.count >= current.count, (line as NSString).substring(from: NSMaxRange(match.range)).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fence = nil }
            } else if let token { fence = token; blank(range) }
            else if line.hasPrefix("    ") || line.hasPrefix("\t") { blank(range) }
            offset += length + 1
        }
        let patterns = [
            "\\A---\\r?\\n[\\s\\S]*?\\r?\\n(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|$)",
            "(`+)[^`]*?\\1", "<!--[\\s\\S]*?-->", "(?i)<(?:script|style|pre|code)\\b[\\s\\S]*?</(?:script|style|pre|code)\\s*>",
            "<[^>\\n]+>", "\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\r\\n]+\\$",
            "!?\\[[^\\]\\r\\n]*\\]\\((?:[^()\\r\\n]|\\([^()\\r\\n]*\\))*\\)",
            "(!?\\[[^\\]\\r\\n]*\\])[ \\t]*(\\[[^\\]\\r\\n]*\\])",
            "(?m)^ {0,3}\\[[^\\]\\r\\n]+\\]:[^\\r\\n]*", "(?i)(?:[a-z][a-z\\d+.-]*://|www\\.)[^\\s<>]+", "(?i)[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}",
            "&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);",
            "\\\\[!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~]"
        ]
        for pattern in patterns {
            let regex = try! NSRegularExpression(pattern: pattern)
            for match in regex.matches(in: text,range: NSRange(location: 0,length: source.length)) {
                if pattern.hasPrefix("!?\\[") {
                    let literal = source.substring(with: match.range) as NSString
                    let destination = literal.range(of: "](")
                    if destination.location != NSNotFound { let start = match.range.location + destination.location + 1; blank(NSRange(location: start,length: NSMaxRange(match.range)-start)) }
                } else if pattern.hasPrefix("(!?\\[") {
                    let start = NSMaxRange(match.range(at: 1)); blank(NSRange(location: start,length: NSMaxRange(match.range)-start))
                } else { blank(match.range) }
            }
        }
        return String(decoding: units,as: UTF16.self)
    }
}
