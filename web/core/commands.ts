import { sourceLines, lineAt, lineEnding, openingFence, closesFence, frontMatterRange } from './source.ts';
import type { SourceLine } from './source.ts';
import { stripFormat } from './format.ts';
export interface Selection { from: number; to: number }
export interface EditorCommand { type: string; value?: any }
export interface EditResult { text: string; selection: Selection }
export interface CommandStyle {boldMarker?:'**'|'__';italicMarker?:'*'|'_';bulletMarker?:'-'|'+'|'*'}
export interface CommandMetadata { type: string; scope: 'inline' | 'line' | 'block'; value?: 'level' | 'language' | 'alert' | 'url' | 'label' }
const inline: Record<string, [string, string]> = {
  bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'], strike: ['~~', '~~'], highlight: ['==', '=='],
  sup: ['<sup>', '</sup>'], sub: ['<sub>', '</sub>'], comment: ['<!--', '-->'], inlineMath: ['$', '$'],
};
const commandMetadata: CommandMetadata[] = [
  ...Object.keys(inline).map(type => ({ type, scope: 'inline' as const })), { type: 'code', scope: 'inline' },
  ...['heading', 'quote', 'bullet', 'ordered', 'task', 'toggleTask', 'indent', 'outdent', 'moveLineUp', 'moveLineDown'].map(type => ({ type, scope: 'line' as const, ...(type === 'heading' ? { value: 'level' as const } : {}) })),
  ...['horizontalRule', 'codeBlock', 'mathBlock', 'toc', 'yaml', 'alert', 'clearFormat', 'insertParagraphBefore', 'insertParagraphAfter', 'deleteBlock', 'deleteWord'].map(type => ({ type, scope: 'block' as const, ...(type === 'codeBlock' ? { value: 'language' as const } : type === 'alert' ? { value: 'alert' as const } : {}) })),
  { type: 'link', scope: 'inline', value: 'url' }, { type: 'image', scope: 'inline', value: 'url' },
  { type: 'footnote', scope: 'inline', value: 'label' }, { type: 'linkReference', scope: 'inline', value: 'url' },
];
export const COMMANDS: readonly CommandMetadata[] = Object.freeze(commandMetadata.map(entry => Object.freeze(entry)));
interface Change { from: number; to: number; insert: string }
function validate(text: string, selection: Selection): void {
  if (!Number.isInteger(selection.from) || !Number.isInteger(selection.to) || selection.from < 0 || selection.to < selection.from || selection.to > text.length) throw new RangeError('Invalid selection');
  for (const position of [selection.from, selection.to]) {
    const before = text.charCodeAt(position - 1), after = text.charCodeAt(position);
    if ((before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) || (text[position - 1] === '\r' && text[position] === '\n')) throw new RangeError('Selection splits a surrogate pair or CRLF');
  }
}
function replace(text: string, from: number, to: number, insert: string, selection: Selection): EditResult {
  return { text: text.slice(0, from) + insert + text.slice(to), selection };
}
function changed(text: string, selection: Selection, changes: Change[]): EditResult {
  const sorted = changes.filter(c => text.slice(c.from, c.to) !== c.insert).sort((a, b) => a.from - b.from);
  const map = (position: number): number => {
    let delta = 0;
    for (const change of sorted) {
      if (position < change.from) break;
      if (position < change.to) return change.from + delta + change.insert.length;
      delta += change.insert.length - (change.to - change.from);
    }
    return position + delta;
  };
  const pieces: string[] = [];
  let cursor = 0;
  for (const change of sorted) { pieces.push(text.slice(cursor, change.from), change.insert); cursor = change.to; }
  pieces.push(text.slice(cursor));
  return { text: pieces.join(''), selection: { from: map(selection.from), to: map(selection.to) } };
}
function difference(line: SourceLine, next: string): Change {
  let before = 0, after = 0;
  while (before < line.text.length && before < next.length && line.text[before] === next[before]) before++;
  while (after < line.text.length - before && after < next.length - before && line.text[line.text.length - 1 - after] === next[next.length - 1 - after]) after++;
  return { from: line.from + before, to: line.to - after, insert: next.slice(before, next.length - after) };
}
function wrap(text: string, selection: Selection, open: string, close: string): EditResult {
  const { from, to } = selection;
  const selected = text.slice(from, to);
  const doubleOnly = (value: string) => (open === '*' || open === '$') && value.startsWith(open + open) && !value.startsWith(open.repeat(3));
  if (!doubleOnly(selected) && selected.length >= open.length + close.length && selected.startsWith(open) && selected.endsWith(close)) {
    const content = selected.slice(open.length, -close.length);
    return replace(text, from, to, content, { from, to: from + content.length });
  }
  const leftRun = (open === '*' || open === '$') ? text.slice(0, from).match(new RegExp('\\' + open + '+$'))?.[0].length : 0;
  const rightRun = (open === '*' || open === '$') ? text.slice(to).match(new RegExp('^\\' + open + '+'))?.[0].length : 0;
  if (!(leftRun === 2 && rightRun === 2) && from >= open.length && text.slice(from - open.length, from) === open && text.slice(to, to + close.length) === close) {
    return replace(text, from - open.length, to + close.length, selected, { from: from - open.length, to: to - open.length });
  }
  return replace(text, from, to, open + selected + close, { from: from + open.length, to: to + open.length });
}
function code(text: string, selection: Selection): EditResult {
  const { from, to } = selection;
  const selected = text.slice(from, to);
  const whole = /^(`+)([\s\S]*?)\1$/.exec(selected);
  if (whole && !whole[2].includes(whole[1])) {
    let content = whole[2];
    if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
    return replace(text, from, to, content, { from, to: from + content.length });
  }
  const left = /`+$/.exec(text.slice(0, from))?.[0];
  const right = /^`+/.exec(text.slice(to))?.[0];
  if (left && left === right && !selected.includes(left)) return wrap(text, selection, left, right);
  const runs = selected.match(/`+/g) ?? [];
  const marker = '`'.repeat(Math.max(0, ...runs.map(run => run.length)) + 1);
  const padding = selected.startsWith('`') || selected.endsWith('`') || (selected.startsWith(' ') && selected.endsWith(' ') && !!selected.trim()) ? ' ' : '';
  return wrap(text, selection, marker + padding, padding + marker);
}
function affected(lines: SourceLine[], selection: Selection): [number, number] {
  return [lineAt(lines, selection.from), lineAt(lines, selection.to > selection.from ? selection.to - 1 : selection.to)];
}
function blockAt(lines: SourceLine[], index: number): [number, number] {
  const opener = (line: string) => openingFence(line) ?? (/^ {0,3}\$\$[ \t]*$/.test(line) ? { marker: '$', length: 2 } : null);
  const closer = (line: string, fence: NonNullable<ReturnType<typeof opener>>) => fence.marker === '$' ? /^ {0,3}\$\$[ \t]*$/.test(line) : closesFence(line, fence);
  let fence: ReturnType<typeof opener> = null, start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!fence) {
      fence = opener(lines[i].text);
      if (fence) start = i;
    } else if (closer(lines[i].text, fence)) {
      if (index >= start && index <= i) return [start, i];
      fence = null;
    }
  }
  if (fence && index >= start) return [start, lines.length - 1];
  if (!lines[index].text.trim()) return [index, index];
  const setext = (line: string) => /^ {0,3}(?:=+|-+)[ \t]*$/.test(line);
  const headingText = (line: string) => !!line.trim() && !/^(?: {4}|\t| {0,3}(?:>|[-+*] |\d+[.)] ))/.test(line);
  if (index > 0 && setext(lines[index].text) && headingText(lines[index - 1].text)) return [index - 1, index];
  if (index + 1 < lines.length && headingText(lines[index].text) && setext(lines[index + 1].text)) return [index, index + 1];
  const indentation = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length;
  const currentIndent = indentation(lines[index].text);
  for (let i = index; i >= 0 && lines[i].text.trim(); i--) {
    const list = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(lines[i].text);
    if (!list || (i < index && indentation(lines[i].text) >= currentIndent)) continue;
    let last = i;
    for (let next = i + 1; next < lines.length; next++) {
      if (!lines[next].text.trim()) continue;
      if (indentation(lines[next].text) <= indentation(lines[i].text)) break;
      last = next;
    }
    if (index <= last) return [i, last];
  }
  const blockStart = (line: string) => /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$)/.test(line) || !!openingFence(line);
  let first = index, last = index;
  if (blockStart(lines[index].text)) return [first, last];
  while (first > 0 && lines[first - 1].text.trim() && !blockStart(lines[first - 1].text)) first--;
  while (last + 1 < lines.length && lines[last + 1].text.trim() && !blockStart(lines[last + 1].text)) last++;
  return [first, last];
}
function moveLines(text: string, selection: Selection, lines: SourceLine[], first: number, last: number, up: boolean): EditResult {
  const finalLine = lines.length - (lines.at(-1)!.text === '' && lines.length > 1 ? 2 : 1);
  if ((up && first === 0) || (!up && last >= finalLine)) return { text, selection: { ...selection } };
  const low = up ? first - 1 : first, high = up ? last : last + 1;
  const indices = up ? [...Array.from({ length: last - first + 1 }, (_, i) => first + i), first - 1] : [last + 1, ...Array.from({ length: last - first + 1 }, (_, i) => first + i)];
  // Newlines belong to positions, keeping a missing final newline on the final line.
  const locations = new Map<number, { from: number; to: number; end: number }>();
  let cursor = lines[low].from;
  const insert = indices.map((index, i) => {
    const line = lines[index], eol = lines[low + i].eol;
    locations.set(index, { from: cursor, to: cursor + line.text.length, end: cursor + line.text.length + eol.length });
    cursor += line.text.length + eol.length;
    return line.text + eol;
  }).join('');
  const map = (position: number, end: boolean): number => {
    if (end && lines[last].eol && position === lines[last].end) return locations.get(last)!.end;
    const index = Math.min(last, lineAt(lines, position));
    const location = locations.get(index)!;
    return Math.min(location.end, location.from + Math.min(lines[index].text.length, position - lines[index].from));
  };
  return replace(text, lines[low].from, lines[high].end, insert, { from: map(selection.from, false), to: map(selection.to, true) });
}
function destination(value: any): string {
  if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) throw new RangeError('URL must be a single-line string');
  const escaped = value.replace(/\\/g, '\\\\').replace(/</g, '%3C').replace(/>/g, '%3E');
  return /[\s()]/u.test(escaped) ? `<${escaped}>` : escaped;
}
function referenceCommand(text: string, selection: Selection, command: EditorCommand): EditResult {
  const footnote = command.type === 'footnote', value = command.value;
  const labels = new Set<string>();
  for (const match of text.matchAll(/^[ \t]{0,3}\[([^\]\r\n]+)\]:/gm)) labels.add(match[1].trim().toLowerCase());
  for (const match of text.matchAll(/\[\^([^\]\r\n]+)\]/g)) labels.add('^' + match[1].toLowerCase());
  const explicit = footnote ? value : typeof value === 'object' && value !== null ? value.label : undefined;
  let label: string;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit || /[\s\[\]\^:]/u.test(explicit)) throw new RangeError('Reference label must be a nonempty single-line identifier');
    label = explicit;
    if (labels.has((footnote ? '^' : '') + label.toLowerCase())) throw new RangeError('Reference label already exists');
  } else {
    let number = 1;
    const prefix = footnote ? '' : 'link-';
    while (labels.has((footnote ? '^' : '') + prefix + number)) number++;
    label = prefix + number;
  }
  const { from, to } = selection, selected = text.slice(from, to), eol = lineEnding(text, from);
  const escapedLabel = selected.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
  const replacement = footnote ? `[^${label}]` : `[${escapedLabel}][${label}]`;
  const updated = text.slice(0, from) + replacement + text.slice(to);
  const trailing = updated.match(/(?:\r\n|\n|\r)+$/)?.[0] ?? '';
  const separator = eol.repeat(Math.max(0, 2 - [...trailing.matchAll(/\r\n|\n|\r/g)].length));
  const prefix = footnote ? `[^${label}]: ` : `[${label}]: `;
  const body = footnote ? selected.replace(/\r\n|\n|\r/g, newline => newline + '    ') : destination(typeof value === 'object' && value !== null ? value.url : value);
  const finalNewline = text.match(/\r\n$|\n$|\r$/)?.[0] ?? '';
  const result = updated + separator + prefix + body + finalNewline;
  const target = footnote ? updated.length + separator.length + prefix.length : from + 1;
  return { text: result, selection: { from: target, to: target + (footnote ? body.length : escapedLabel.length) } };
}
export function applyCommand(text: string, selection: Selection, command: EditorCommand,style:CommandStyle={}): EditResult {
  validate(text, selection);
  const { from, to } = selection;
  const type = command.type;
  if (type === 'footnote' || type === 'linkReference') return referenceCommand(text, selection, command);
  if(type==='bold'||type==='italic'){
    const choices=type==='bold'?['**','__']:['*','_'],chosen=type==='bold'?style.boldMarker??'**':style.italicMarker??'*';
    const selected=text.slice(from,to),existing=choices.find(marker=>(selected.startsWith(marker)&&selected.endsWith(marker)&&selected.length>=2*marker.length)||(text.slice(from-marker.length,from)===marker&&text.slice(to,to+marker.length)===marker));
    const marker=existing??chosen;return wrap(text,selection,marker,marker);
  }
  if (Object.hasOwn(inline, type)) return wrap(text, selection, ...inline[type]);
  if (type === 'code') return code(text, selection);
  if (type === 'link' || type === 'image') {
    const open = type === 'link' ? '[' : '![', close = `](${destination(command.value)})`;
    const selected = text.slice(from, to);
    if ((selected.startsWith(open) && selected.endsWith(close)) || (text.slice(from - open.length, from) === open && text.slice(to, to + close.length) === close)) return wrap(text, selection, open, close);
    const label = selected.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&');
    return replace(text, from, to, open + label + close, { from: from + open.length, to: from + open.length + label.length });
  }
  if (type === 'clearFormat') {
    const lines = sourceLines(text);
    let start = from === to ? lines[lineAt(lines, from)].from : from;
    let end = from === to ? lines[lineAt(lines, from)].to : to;
    if(from!==to){
      const pairs=[...Object.values(inline),['__','__'],['_','_']],plain=stripFormat(text);
      for(;;){
        const left=/`+$/.exec(text.slice(0,start))?.[0],right=/^`+/.exec(text.slice(end))?.[0];
        const pair=pairs.find(([open,close])=>start>=open.length&&text.slice(start-open.length,start)===open&&text.slice(end,end+close.length)===close
          &&stripFormat(text.slice(0,start-open.length)+text.slice(start,end)+text.slice(end+close.length))===plain)
          ??(left&&left===right?[left,right]:undefined);
        if(!pair)break;start-=pair[0].length;end+=pair[1].length;
      }
    }
    const original = text.slice(start, end), next = stripFormat(original);
    const changes: Change[] = [];
    let cursor = 0;
    for (const character of next) {
      const index = original.indexOf(character, cursor);
      if (index < 0) throw new Error('Format removal must preserve content order');
      if (index > cursor) changes.push({ from: start + cursor, to: start + index, insert: '' });
      cursor = index + character.length;
    }
    if (cursor < original.length) changes.push({ from: start + cursor, to: end, insert: '' });
    return changed(text, selection, changes);
  }
  if (type === 'deleteWord') {
    let start = from;
    if (from === to && from > 0) {
      const prefix = text.slice(0, from);
      const segments = [...new Intl.Segmenter('und', { granularity: 'word' }).segment(prefix)];
      let i = segments.length - 1;
      while (i > 0 && /^\s+$/u.test(segments[i].segment)) i--;
      start = segments[i]?.index ?? from;
      // Non-word symbols can span multiple code points (emoji families, skin tones).
      if (segments[i] && !segments[i].isWordLike && !/^\s+$/u.test(segments[i].segment)) {
        const graphemes = [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(prefix.slice(0, segments[i].index + segments[i].segment.length))];
        start = graphemes.at(-1)?.index ?? start;
      }
    }
    return replace(text, start, to, '', { from: start, to: start });
  }
  const lines = sourceLines(text);
  const [first, last] = affected(lines, selection);
  const selectedLines = lines.slice(first, last + 1);
  const eol = lineEnding(text, from);
  if (type === 'yaml') {
    const existing = frontMatterRange(text);
    if (existing) return { text, selection: { from: existing.contentFrom, to: existing.contentTo } };
    const insert = `---${eol}${eol}---${eol}`;
    const position = 3 + eol.length;
    const bom = text.startsWith('\uFEFF') ? 1 : 0;
    return replace(text, bom, bom, insert, { from: position + bom, to: position + bom });
  }
  if (type === 'toc') {
    const prefix = text.slice(0, from), suffix = text.slice(to);
    const before = prefix && !/(?:\r\n|\n|\r){2}$/.test(prefix) ? (/(?:\r\n|\n|\r)$/.test(prefix) ? eol : eol + eol) : '';
    const after = suffix && !/^(?:\r\n|\n|\r){2}/.test(suffix) ? (/^(?:\r\n|\n|\r)/.test(suffix) ? eol : eol + eol) : '';
    const position = from + before.length + 5;
    return replace(text, from, to, before + '[TOC]' + after, { from: position, to: position });
  }
  if (type === 'moveLineUp' || type === 'moveLineDown') return moveLines(text, selection, lines, first, last, type === 'moveLineUp');
  if (type === 'deleteBlock' || type === 'insertParagraphBefore' || type === 'insertParagraphAfter') {
    const [blockFirst] = blockAt(lines, first), [, blockLast] = blockAt(lines, last);
    if (type === 'deleteBlock') {
      const start = lines[blockFirst].from;
      return replace(text, start, lines[blockLast].end, '', { from: start, to: start });
    }
    if (type === 'insertParagraphBefore') {
      const start = lines[blockFirst].from;
      return replace(text, start, start, eol + eol, { from: start, to: start });
    }
    const end = lines[blockLast].end;
    const insert = lines[blockLast].eol ? eol + eol : eol + eol + eol + eol;
    const position = lines[blockLast].eol ? end + eol.length : end + 2 * eol.length;
    return replace(text, end, end, insert, { from: position, to: position });
  }
  if (type === 'horizontalRule') {
    const start = lines[first].from, end = lines[last].to;
    return replace(text, start, end, '---', { from: start + 3, to: start + 3 });
  }
  if (type === 'codeBlock' || type === 'mathBlock') {
    const start = lines[first].from, end = lines[last].to;
    const content = text.slice(start, end);
    let marker = '$$', language = '';
    if (type === 'codeBlock') {
      language = command.value ?? '';
      if (typeof language !== 'string' || /[\r\n`\u0000]/.test(language)) throw new RangeError('Code language must be a single-line fence info string');
      marker = '`'.repeat(Math.max(2, ...(content.match(/`+/g) ?? []).map(run => run.length)) + 1);
    }
    const prefix = marker + language + eol;
    return replace(text, start, end, prefix + content + eol + marker, { from: Math.min(from, end) + prefix.length, to: Math.min(to, end) + prefix.length });
  }
  if (type === 'alert') {
    const kind = command.value;
    if (!['note', 'tip', 'important', 'warning', 'caution'].includes(kind)) throw new RangeError('Invalid alert type');
    const header = `> [!${kind.toUpperCase()}]${eol}`;
    return changed(text, selection, selectedLines.map((line, index) => ({ from: line.from, to: line.from, insert: (index === 0 ? header : '') + '> ' })));
  }
  if (['heading', 'quote', 'bullet', 'ordered', 'task', 'toggleTask', 'indent', 'outdent'].includes(type)) {
    const level = command.value;
    if (type === 'heading' && (!Number.isInteger(level) || level < 1 || level > 6)) throw new RangeError('Heading level must be 1–6');
    const listParts = (line: string) => /^([ \t]*)(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?)?([\s\S]*)$/.exec(line)!;
    const toggle = type === 'quote' ? selectedLines.every(line => /^([ \t]*)>[ \t]?/.test(line.text))
      : type === 'heading' ? selectedLines.every(line => new RegExp('^([ \\t]*)#{' + level + '}[ \\t]+').test(line.text))
      : type === 'bullet' ? selectedLines.every(line => /^([ \t]*)[-+*][ \t]+(?!\[[ xX]\])/.test(line.text))
      : type === 'ordered' ? selectedLines.every(line => /^([ \t]*)\d+[.)][ \t]+/.test(line.text))
      : type === 'task' ? selectedLines.every(line => listParts(line.text)[2] !== undefined) : false;
    const changes = selectedLines.map((line, index) => {
      let next = line.text;
      const indent = /^[ \t]*/.exec(next)![0];
      if (type === 'indent') next = '  ' + next;
      else if (type === 'outdent') next = next.replace(/^(?:\t| {1,2})/, '');
      else if (type === 'heading') {
        const body = next.slice(indent.length).replace(/^#{1,6}[ \t]+/, '');
        next = indent + (toggle ? '' : '#'.repeat(level) + ' ') + body;
      } else if (type === 'quote') next = toggle ? next.replace(/^([ \t]*)>[ \t]?/, '$1') : indent + '> ' + next.slice(indent.length);
      else {
        const parts = listParts(next);
        if (type === 'toggleTask' && parts[2] !== undefined) next = next.replace(/\[([ xX])\]/, (_, state) => state === ' ' ? '[x]' : '[ ]');
        else next = parts[1] + (toggle ? '' : type === 'ordered' ? `${index + 1}. ` : type === 'bullet' ? `${style.bulletMarker??'-'} ` : '- [ ] ') + parts[3];
      }
      return difference(line, next);
    });
    return changed(text, selection, changes);
  }
  return { text, selection: { ...selection } };
}
