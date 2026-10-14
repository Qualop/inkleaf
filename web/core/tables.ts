export type Alignment = 'left' | 'center' | 'right' | null;
export interface MarkdownTable { headers: string[]; rows: string[][]; alignments: Alignment[] }

// Keep the public decoded cells while retaining the Markdown spelling of untouched cells.
interface RawCell { value: string; source: string }
const rawCells = new WeakMap<string[], (RawCell | undefined)[]>();
function copyCells(cells: string[]): string[] {
  const result = [...cells], raw = rawCells.get(cells);
  if (raw) rawCells.set(result, [...raw]);
  return result;
}

function checkIndex(index: number, size: number, insertion = false): void {
  if (!Number.isInteger(index) || index < 0 || index >= size + (insertion ? 1 : 0)) throw new RangeError('Table index out of bounds');
}
function checkTable(table: MarkdownTable): void {
  const width = table.headers.length;
  if (!width || table.alignments.length !== width || table.rows.some(row => row.length !== width)) throw new RangeError('Table must be rectangular with at least one column');
  if (![...table.headers, ...table.rows.flat()].every(cell => typeof cell === 'string')) throw new TypeError('Table cells must be strings');
  if (!table.alignments.every(alignment => [null, 'left', 'center', 'right'].includes(alignment))) throw new RangeError('Invalid alignment');
}
function copy(table: MarkdownTable): MarkdownTable {
  checkTable(table);
  return { headers: copyCells(table.headers), rows: table.rows.map(copyCells), alignments: [...table.alignments] };
}
function escaped(source: string, index: number): boolean {
  let count = 0;
  while (index > 0 && source[--index] === '\\') count++;
  return count % 2 === 1;
}
function splitRow(source: string): string[] {
  const row = source.trim();
  const cells: string[] = [];
  const raw: RawCell[] = [];
  const add = (source: string) => {
    source = source.trim();
    const value = source.replace(/\\([\\|])/g, '$1');
    cells.push(value); raw.push({ value, source });
  };
  let start = row.startsWith('|') ? 1 : 0;
  let ticks = 0;
  for (let i = start; i < row.length; i++) {
    if (row[i] === '`' && !escaped(row, i)) {
      let end = i;
      while (row[end] === '`') end++;
      const run = end - i;
      if (ticks === run) ticks = 0;
      else if (ticks === 0) {
        // An unmatched opener is literal, so it cannot consume a later cell delimiter.
        const closings = row.slice(end).matchAll(new RegExp('(?<!`)`{' + run + '}(?!`)', 'g'));
        if ([...closings].some(match => !escaped(row, end + match.index!))) ticks = run;
      }
      i = end - 1;
    } else if (row[i] === '|' && !ticks && !escaped(row, i)) {
      add(row.slice(start, i));
      start = i + 1;
    }
  }
  if (start < row.length || !row.endsWith('|') || escaped(row, row.length - 1)) {
    add(row.slice(start));
  }
  rawCells.set(cells, raw);
  return cells;
}
export function parseTable(source: string): MarkdownTable | null {
  const lines = source.trim().split(/\r\n|\n|\r/);
  if (lines.length < 2) return null;
  const headers = splitRow(lines[0]);
  const separator = splitRow(lines[1]);
  if (!headers.length || headers.length !== separator.length || separator.some(cell => !/^:?-+:?$/.test(cell))) return null;
  const alignments: Alignment[] = separator.map(cell => cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : cell.endsWith(':') ? 'right' : null);
  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    if (!line.trim()) return null;
    const cells = splitRow(line);
    const row = headers.map((_, index) => cells[index] ?? '');
    rawCells.set(row, headers.map((_, index) => rawCells.get(cells)?.[index]));
    rows.push(row);
  }
  return { headers, rows, alignments };
}
export function serializeTable(table: MarkdownTable): string {
  checkTable(table);
  const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\n|\r/g, '<br>');
  const row = (cells: string[]) => {
    const raw = rawCells.get(cells);
    return `| ${cells.map((value, index) => {
      const original = raw?.[index];
      if (!original || original.value !== value) return cell(value);
      return original.source.replace(/\|/g, (pipe, offset) => escaped(original.source, offset) ? pipe : '\\|');
    }).join(' | ')} |`;
  };
  const separators = table.alignments.map(alignment => alignment === 'left' ? ':---' : alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : '---');
  return [row(table.headers), row(separators), ...table.rows.map(row)].join('\n');
}
export function createTable(rows: number, cols: number): MarkdownTable {
  if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(cols) || cols < 1) throw new RangeError('Invalid table dimensions');
  return { headers: Array(cols).fill(''), rows: Array.from({ length: rows }, () => Array(cols).fill('')), alignments: Array(cols).fill(null) };
}
export function updateCell(table: MarkdownTable, row: number, col: number, value: string): MarkdownTable {
  const result = copy(table);
  checkIndex(col, result.headers.length);
  if (row !== -1) checkIndex(row, result.rows.length);
  if (typeof value !== 'string') throw new TypeError('Cell value must be a string');
  const cells = row === -1 ? result.headers : result.rows[row];
  if (cells[col] !== value) {
    const raw = rawCells.get(cells);
    if (raw) raw[col] = undefined;
  }
  cells[col] = value;
  return result;
}
export function insertRow(table: MarkdownTable, index: number): MarkdownTable {
  const result = copy(table);
  checkIndex(index, result.rows.length, true);
  result.rows.splice(index, 0, Array(result.headers.length).fill(''));
  return result;
}
export function removeRow(table: MarkdownTable, index: number): MarkdownTable {
  const result = copy(table);
  checkIndex(index, result.rows.length);
  result.rows.splice(index, 1);
  return result;
}
function move<T>(items: T[], index: number, destination: number): void {
  checkIndex(index, items.length);
  checkIndex(destination, items.length);
  const [item] = items.splice(index, 1);
  items.splice(destination, 0, item);
}
export function moveRow(table: MarkdownTable, index: number, destination = Math.min(index + 1, table.rows.length - 1)): MarkdownTable {
  const result = copy(table);
  move(result.rows, index, destination);
  return result;
}
export function insertColumn(table: MarkdownTable, index: number): MarkdownTable {
  const result = copy(table);
  checkIndex(index, result.headers.length, true);
  result.headers.splice(index, 0, '');
  rawCells.get(result.headers)?.splice(index, 0, undefined);
  result.alignments.splice(index, 0, null);
  for (const row of result.rows) { row.splice(index, 0, ''); rawCells.get(row)?.splice(index, 0, undefined); }
  return result;
}
export function removeColumn(table: MarkdownTable, index: number): MarkdownTable {
  const result = copy(table);
  checkIndex(index, result.headers.length);
  if (result.headers.length === 1) throw new RangeError('Cannot remove the final column');
  result.headers.splice(index, 1);
  rawCells.get(result.headers)?.splice(index, 1);
  result.alignments.splice(index, 1);
  for (const row of result.rows) { row.splice(index, 1); rawCells.get(row)?.splice(index, 1); }
  return result;
}
export function moveColumn(table: MarkdownTable, index: number, destination = Math.min(index + 1, table.headers.length - 1)): MarkdownTable {
  const result = copy(table);
  move(result.headers, index, destination);
  const headerRaw = rawCells.get(result.headers);
  if (headerRaw) move(headerRaw, index, destination);
  move(result.alignments, index, destination);
  for (const row of result.rows) {
    move(row, index, destination);
    const raw = rawCells.get(row);
    if (raw) move(raw, index, destination);
  }
  return result;
}
export function setAlignment(table: MarkdownTable, col: number, alignment: Alignment): MarkdownTable {
  const result = copy(table);
  checkIndex(col, result.headers.length);
  if (![null, 'left', 'center', 'right'].includes(alignment)) throw new RangeError('Invalid alignment');
  result.alignments[col] = alignment;
  return result;
}
