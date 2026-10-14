export interface SearchOptions { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }
export interface SearchMatch { from: number; to: number; groups?: string[] }
interface Match extends SearchMatch { raw: RegExpExecArray }
const word = /[\p{L}\p{N}\p{M}\p{Pc}]/u;
function previousCharacter(text: string, position: number): string {
  if (!position) return '';
  const last = text.charCodeAt(position - 1);
  return text.slice(last >= 0xdc00 && last <= 0xdfff && position > 1 ? position - 2 : position - 1, position);
}
function nextCharacter(text: string, position: number): string {
  const code = text.codePointAt(position);
  return code === undefined ? '' : String.fromCodePoint(code);
}
function matches(text: string, query: string, options: SearchOptions): Match[] {
  if (!query && !options.regex) return [];
  const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(source, `gu${options.caseSensitive ? '' : 'i'}`);
  const result: Match[] = [];
  let raw: RegExpExecArray | null;
  while ((raw = pattern.exec(text))) {
    const from = raw.index, to = from + raw[0].length;
    if (!options.wholeWord || (!word.test(previousCharacter(text, from)) && !word.test(nextCharacter(text, to)))) {
      result.push({ from, to, ...(options.regex ? { groups: raw.slice(1).map(group => group ?? '') } : {}), raw });
    }
    if (raw[0].length === 0) {
      if (pattern.lastIndex >= text.length) break;
      pattern.lastIndex += nextCharacter(text, pattern.lastIndex).length;
    }
  }
  return result;
}
export function findMatches(text: string, query: string, options: SearchOptions = {}): SearchMatch[] {
  return matches(text, query, options).map(({ raw, ...match }) => match);
}
function expand(text: string, match: Match, replacement: string): string {
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (token, key: string) => {
    if (key === '$') return '$';
    if (key === '&') return match.raw[0];
    if (key === '`') return text.slice(0, match.from);
    if (key === "'") return text.slice(match.to);
    if (key.startsWith('<')) return match.raw.groups ? (match.raw.groups[key.slice(1, -1)] ?? '') : token;
    const index = Number(key);
    if (index > 0 && index < match.raw.length) return match.raw[index] ?? '';
    if (key.length === 2 && Number(key[0]) > 0 && Number(key[0]) < match.raw.length) return (match.raw[Number(key[0])] ?? '') + key[1];
    return token;
  });
}
export function replaceMatches(text: string, query: string, replacement: string, options: SearchOptions = {}): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const match of matches(text, query, options)) {
    chunks.push(text.slice(cursor, match.from), options.regex ? expand(text, match, replacement) : replacement);
    cursor = match.to;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}
