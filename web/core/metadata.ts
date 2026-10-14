import { frontMatterRange, sourceLines } from './source.ts';
export interface FrontMatter { data: Record<string, unknown>; body: string; range?: { from: number; to: number } }
interface YamlLine { indent: number; value: string; line: number; raw: string }
function fail(message: string, line?: number): never { throw new SyntaxError(`Front matter: ${message}${line ? ` (line ${line})` : ''}`); }

function scan(source: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0, quote = '', depth = 0;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (quote) {
      if (quote === '"' && character === '\\') { i++; continue; }
      if (quote === "'" && character === "'" && source[i + 1] === "'") { i++; continue; }
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    else if (character === separator && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  if (quote || depth !== 0) fail('Unclosed quoted or flow value');
  parts.push(source.slice(start));
  return parts;
}
function withoutComment(source: string): string {
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    if (quote === '"' && source[i] === '\\') { i++; continue; }
    if (quote === "'" && source[i] === "'" && source[i + 1] === "'") { i++; continue; }
    if (quote) { if (source[i] === quote) quote = ''; }
    else if (source[i] === '"' || source[i] === "'") quote = source[i];
    else if (source[i] === '#' && (i === 0 || /\s/.test(source[i - 1]))) return source.slice(0, i).trimEnd();
  }
  return source.trimEnd();
}
function put(data: Record<string, unknown>, key: string, value: unknown): void {
  if (Object.hasOwn(data, key)) fail(`Duplicate key ${key}`);
  Object.defineProperty(data, key, { value, enumerable: true, configurable: true, writable: true });
}
function mappingPair(source: string): [string, string] {
  let quote = '', depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote === '"' && ch === '\\') { i++; continue; }
    if (quote === "'" && ch === "'" && source[i + 1] === "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === source.length || /\s/.test(source[i + 1]))) {
      const rawKey = source.slice(0, i).trim();
      if (!rawKey || rawKey === '<<') fail('Unsupported mapping key');
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? scalar(rawKey) : rawKey;
      if (typeof key !== 'string') fail('Mapping keys must be strings');
      return [key, source.slice(i + 1).trim()];
    }
  }
  fail('Expected a key: value mapping');
}
function scalar(source: string): unknown {
  const value = source.trim();
  if (/^[!&*]|^<<:/.test(value)) fail('Tags, anchors and aliases are unsupported');
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* Report below with source context. */ }
    fail('Invalid double-quoted string');
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) fail('Invalid single-quoted string');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) fail('Unclosed flow sequence');
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const items = scan(inner, ',');
    if (items.at(-1)?.trim() === '') items.pop();
    if (items.some(item => !item.trim())) fail('Empty flow sequence item');
    return items.map(scalar);
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) fail('Unclosed flow mapping');
    const result: Record<string, unknown> = {};
    const inner = value.slice(1, -1).trim();
    for (const part of inner ? scan(inner, ',') : []) {
      const [key, raw] = mappingPair(part);
      put(result, key, scalar(raw));
    }
    return result;
  }
  if (value === '' || /^(null|~)$/i.test(value)) return null;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) fail('Non-finite number');
    return number;
  }
  if (/^[|>]/.test(value)) fail('Block scalar needs a multiline context');
  return value;
}
function parseYaml(content: string): Record<string, unknown> {
  const lines: YamlLine[] = sourceLines(content).map((line, index) => {
    if (/^ *\t/.test(line.text)) fail('Tabs in indentation are unsupported', index + 1);
    const indent = /^ */.exec(line.text)![0].length;
    return { indent, value: withoutComment(line.text.slice(indent)), raw: line.text, line: index + 1 };
  });
  let position = 0;
  const skip = () => { while (position < lines.length && !lines[position].value.trim()) position++; };
  function block(indent: number): Record<string, unknown> | unknown[] {
    skip();
    const sequence = /^-(?:\s|$)/.test(lines[position]?.value ?? '');
    const result: any = sequence ? [] : {};
    while (position < lines.length) {
      skip();
      const entry = lines[position];
      if (!entry || entry.indent < indent) break;
      if (entry.indent > indent) fail('Unexpected indentation', entry.line);
      const isItem = /^-(?:\s|$)/.test(entry.value);
      if (isItem !== sequence) fail('Mixed mapping and sequence', entry.line);
      position++;
      let key = '', raw = entry.value;
      if (sequence) raw = raw.replace(/^-[ \t]?/, '').trim();
      else [key, raw] = mappingPair(raw);
      let value: unknown;
      if (/^[|>][+-]?$/.test(raw)) {
        const pieces: string[] = [];
        let contentIndent: number | undefined;
        while (position < lines.length) {
          const next = lines[position];
          if (next.raw.trim() && next.indent <= indent) break;
          // sourceLines' final empty sentinel is not an additional YAML content line.
          if (position === lines.length - 1 && next.raw === '') { position++; break; }
          if (next.raw.trim() && contentIndent === undefined) contentIndent = next.indent;
          pieces.push(next.raw.slice(contentIndent ?? indent + 1));
          position++;
        }
        value = raw[0] === '>' ? pieces.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ') : pieces.join('\n');
        value = raw.endsWith('+') ? String(value) + '\n' : raw.endsWith('-') ? String(value).replace(/\n+$/, '') : String(value).replace(/\n*$/, '\n');
      } else if (!raw) {
        skip();
        value = lines[position] && lines[position].indent > indent ? block(lines[position].indent) : null;
      } else {
        let sequenceMapping = false;
        if (sequence && /:(?:\s|$)/.test(raw) && !/^[\[{]/.test(raw)) {
          try { mappingPair(raw); sequenceMapping = true; } catch { /* A quoted scalar can contain a literal colon. */ }
        }
        if (sequenceMapping) {
          const itemIndent = entry.indent + 2;
          lines.splice(position - 1, 1, { ...entry, indent: itemIndent, value: raw, raw: ' '.repeat(itemIndent) + raw });
          position--;
          value = block(itemIndent);
        } else value = scalar(raw);
      }
      if (sequence) result.push(value);
      else put(result, key, value);
    }
    return result;
  }
  skip();
  if (position >= lines.length) return {};
  if (lines[position].indent !== 0) fail('Root mapping must not be indented');
  const result = block(0);
  if (Array.isArray(result)) fail('Root must be a mapping');
  return result;
}
export function parseFrontMatter(text: string): FrontMatter {
  const range = frontMatterRange(text);
  if (!range) return { data: {}, body: text };
  return { data: parseYaml(text.slice(range.contentFrom, range.contentTo)), body: text.slice(range.to), range: { from: range.from, to: range.to } };
}
