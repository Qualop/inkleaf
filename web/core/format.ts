import { sourceLines, openingFence, closesFence } from './source.ts';
function protector(source: string): { save: (literal: string) => string; restore: (text: string) => string } {
  let delimiter = '\u0000';
  while (source.includes(delimiter)) delimiter += '\u0000';
  const literals: string[] = [];
  const pattern = new RegExp(delimiter + '(\\d+)' + delimiter, 'g');
  return {
    save: literal => delimiter + (literals.push(literal) - 1) + delimiter,
    restore: text => {
      for (let depth = 0; depth <= literals.length; depth++) {
        const next = text.replace(pattern, (_, index) => literals[Number(index)]);
        if (next === text) return text;
        text = next;
      }
      return text;
    },
  };
}
export function stripInline(source: string): string {
  const protectedText = protector(source);
  const runs = [...source.matchAll(/`+/g)].filter(match => {
    let slashes = 0, position = match.index!;
    while (position > 0 && source[--position] === '\\') slashes++;
    return slashes % 2 === 0;
  });
  const nextSame = new Map<number, number>(), partners = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const next = nextSame.get(runs[i][0].length);
    if (next !== undefined) partners.set(i, next);
    nextSame.set(runs[i][0].length, i);
  }
  let cursor = 0;
  const pieces: string[] = [];
  const protectEscapes = (text: string) => text.replace(/\\[\\`*{}\[\]()#+\-.!_$~^=<>]/g, protectedText.save);
  for (let i = 0; i < runs.length; i++) {
    const partner = partners.get(i);
    if (partner === undefined) continue;
    const opener = runs[i], closer = runs[partner];
    pieces.push(protectEscapes(source.slice(cursor, opener.index)));
    let content = source.slice(opener.index! + opener[0].length, closer.index);
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
    pieces.push(protectedText.save(content));
    cursor = closer.index! + closer[0].length;
    i = partner;
  }
  pieces.push(protectEscapes(source.slice(cursor)));
  let text = pieces.join('');
  text = text.replace(/!?\[([^\]\r\n]*)\]\((?:\\.|[^()\r\n]|\([^()\r\n]*\))*\)/g, '$1');
  for (let i = 0; i < 4; i++) {
    text = text.replace(/<(u|sup|sub)>([\s\S]*?)<\/\1>/g, '$2')
      .replace(/<!--([\s\S]*?)-->/g, '$1')
      .replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(?<![\p{L}\p{N}])_(?=\S)([^_\r\n]*?\S)_(?![\p{L}\p{N}])/gu, '$1')
      .replace(/(?<!\*)\*(?=\S)([^*\r\n]*?\S)\*(?!\*)/g, '$1')
      .replace(/(?<!\$)\$([^$\r\n]+)\$(?!\$)/g, '$1');
  }
  return protectedText.restore(text);
}
export function stripFormat(source: string): string {
  const protectedText = protector(source);
  const lines = sourceLines(source);
  const pieces: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], fence = openingFence(line.text);
    if (fence || /^ {0,3}\$\$[ \t]*$/.test(line.text)) {
      let close = i + 1;
      while (close < lines.length && !(fence ? closesFence(lines[close].text, fence) : /^ {0,3}\$\$[ \t]*$/.test(lines[close].text))) close++;
      if (close < lines.length) {
        const contentEnd = close > i + 1 ? lines[close - 1].to : line.end;
        pieces.push(protectedText.save(source.slice(line.end, contentEnd)), lines[close].eol);
        i = close;
        continue;
      }
    }
    if (line.text.trim() && i + 1 < lines.length && /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[i + 1].text)) {
      pieces.push(stripInline(line.text), lines[i + 1].eol);
      i++;
      continue;
    }
    let body = line.text, previous = '';
    while (body !== previous) {
      previous = body;
      body = body.replace(/^([ \t]*)(?:#{1,6}[ \t]+|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/, '$1');
    }
    pieces.push(body, line.eol);
  }
  return protectedText.restore(stripInline(pieces.join('')));
}
