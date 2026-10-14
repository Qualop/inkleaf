import { sourceLines, openingFence, closesFence, frontMatterRange } from './source.ts';
import { stripInline } from './format.ts';
export interface Statistics { words: number; characters: number; charactersNoSpaces: number; lines: number; readingMinutes: number }
export interface OutlineEntry { level: number; title: string; line: number; from: number; to: number; id: string }
export function getStatistics(text: string, wordsPerMinute = 240): Statistics {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) throw new RangeError('Reading speed must be positive');
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
  let words = 0;
  for (const segment of segmenter.segment(text)) if (segment.isWordLike) words++;
  return { words, characters: Array.from(text).length, charactersNoSpaces: Array.from(text.replace(/\s/gu, '')).length, lines: text ? sourceLines(text).length : 0, readingMinutes: Math.ceil(words / wordsPerMinute) };
}
export function getOutline(text: string): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const lines = sourceLines(text);
  const metadataEnd = frontMatterRange(text)?.to ?? 0;
  let fence: ReturnType<typeof openingFence> = null;
  let math = false;
  function add(level: number, titleSource: string, index: number, to: number): void {
    const title = stripInline(titleSource).trim();
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{Pc}\-\s]/gu, '').replace(/\s/g, '-');
    let count = counts.get(base) ?? 0;
    let id = count ? `${base}-${count}` : base;
    while (used.has(id)) { count++; id = `${base}-${count}`; }
    counts.set(base, count + 1);
    used.add(id);
    result.push({ level, title, line: index + 1, from: lines[index].from, to, id });
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.from < metadataEnd) continue;
    if (fence) { if (closesFence(line.text, fence)) fence = null; continue; }
    if (/^ {0,3}\$\$[ \t]*$/.test(line.text)) { math = !math; continue; }
    if (math) continue;
    fence = openingFence(line.text);
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line.text);
    if (atx) { add(atx[1].length, (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, ''), i, line.to); continue; }
    if (line.text.trim() && !/^(?: {4}|\t| {0,3}(?:>|[-+*] |\d+[.)] ))/.test(line.text) && i + 1 < lines.length) {
      const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i + 1].text);
      if (underline) { add(underline[1][0] === '=' ? 1 : 2, line.text, i, lines[i + 1].to); i++; }
    }
  }
  return result;
}
