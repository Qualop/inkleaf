export interface SourceLine { from: number; to: number; end: number; text: string; eol: string }
export function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  for (const match of text.matchAll(/\r\n|\n|\r/g)) {
    const to = match.index!;
    lines.push({ from, to, end: to + match[0].length, text: text.slice(from, to), eol: match[0] });
    from = to + match[0].length;
  }
  lines.push({ from, to: text.length, end: text.length, text: text.slice(from), eol: '' });
  return lines;
}
export function lineAt(lines: SourceLine[], position: number): number {
  let low = 0, high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle].from <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}
export function lineEnding(text: string, position = 0): string {
  const lines = sourceLines(text);
  const line = lines[lineAt(lines, position)];
  return line.eol || (text.match(/\r\n|\n|\r/)?.[0] ?? '\n');
}
export interface Fence { marker: string; length: number }
export function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1][0], length: match[1].length };
}
export function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1][0] === fence.marker && match[1].length >= fence.length;
}
export function frontMatterRange(text: string): { from: number; to: number; contentFrom: number; contentTo: number } | undefined {
  const lines = sourceLines(text);
  if (!/^\uFEFF?---[ \t]*$/.test(lines[0].text)) return;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i].text)) {
      return { from: 0, to: lines[i].end, contentFrom: lines[0].end, contentTo: lines[i].from };
    }
  }
}
