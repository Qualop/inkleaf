import { parseTable, serializeTable, createTable, updateCell, insertRow, removeRow, moveRow, insertColumn, removeColumn, moveColumn, setAlignment } from '../core/tables.ts';
import type { MarkdownTable, Alignment } from '../core/tables.ts';
import { markdownBlocks } from '../render/markdown.ts';
import { lineEnding } from '../core/source.ts';
import { button, field, input, select, modal } from './dialog.ts';
import type { DocumentEditor } from './editor.ts';
export function tableDialog(root: HTMLElement, editor: DocumentEditor, valid: () => boolean, report: (error: unknown) => void): void {
  const source = editor.text(), selection = editor.selection();
  const block = markdownBlocks(source).find(block => block.type === 'table' && selection.from >= block.from && selection.from < block.to);
  const range = block ? { from: block.from, to: block.to } : selection;
  const existing = source.slice(range.from, range.to), parsed = parseTable(existing);
  if (!parsed && (block || existing.trim())) {
    report(new Error('Table source could not be parsed. It may be malformed or use unsupported syntax.'));
    return;
  }
  let table: MarkdownTable = parsed ?? createTable(2, 2);
  const dialog = modal(root, block ? 'Edit Table' : 'Insert Table'); dialog.element.classList.add('table-dialog');
  const tools = document.createElement('div'); tools.className = 'table-tools'; const rowIndex = input('number', '1'), colIndex = input('number', '1'); rowIndex.min = '1'; colIndex.min = '1'; tools.append(field('Row', rowIndex), field('Column', colIndex));
  const cells = document.createElement('div'); cells.className = 'table-scroll';
  function render() {
    cells.replaceChildren(); const element = document.createElement('table');
    for (let row = -1; row < table.rows.length; row++) {
      const tr = document.createElement('tr');
      for (let col = 0; col < table.headers.length; col++) {
        const td = document.createElement(row === -1 ? 'th' : 'td'), control = document.createElement('textarea'); control.rows = 1; control.value = row === -1 ? table.headers[col] : table.rows[row][col]; control.dataset.cellRow = String(row); control.dataset.cellCol = String(col); control.setAttribute('aria-label', `${row === -1 ? 'Header' : `Row ${row + 1}`}, column ${col + 1}`); control.addEventListener('input', () => { table = updateCell(table, row, col, control.value); }); td.append(control); tr.append(td);
      }
      element.append(tr);
    }
    cells.append(element); rowIndex.max = String(table.rows.length + 1); colIndex.max = String(table.headers.length + 1);
  }
  const operate = (label: string, transform: () => MarkdownTable) => { const control = button(label); control.addEventListener('click', () => { try { table = transform(); render(); } catch (error) { report(error); } }); tools.append(control); };
  operate('Insert row', () => insertRow(table, Number(rowIndex.value) - 1)); operate('Remove row', () => removeRow(table, Number(rowIndex.value) - 1)); operate('Row up', () => moveRow(table, Number(rowIndex.value) - 1, Number(rowIndex.value) - 2)); operate('Row down', () => moveRow(table, Number(rowIndex.value) - 1, Number(rowIndex.value)));
  operate('Insert column', () => insertColumn(table, Number(colIndex.value) - 1)); operate('Remove column', () => removeColumn(table, Number(colIndex.value) - 1)); operate('Column left', () => moveColumn(table, Number(colIndex.value) - 1, Number(colIndex.value) - 2)); operate('Column right', () => moveColumn(table, Number(colIndex.value) - 1, Number(colIndex.value)));
  const alignment = select([['', 'Default'], ['left', 'Left'], ['center', 'Center'], ['right', 'Right']], ''); tools.append(field('Alignment', alignment)); alignment.addEventListener('change', () => { try { table = setAlignment(table, Number(colIndex.value) - 1, (alignment.value || null) as Alignment); } catch (error) { report(error); } });
  dialog.body.append(tools, cells); const apply = button('Apply Table', 'table-apply');
  apply.addEventListener('click', () => {
    try {
      if (!valid()) throw new Error('Document changed. Close and reopen the table editor.');
      const original = source.slice(range.from, range.to), eol = lineEnding(source,range.from); let replacement = serializeTable(table).replace(/\n/g, eol);
      if (block) replacement += original.match(/(?:\r\n|\n|\r)$/)?.[0] ?? '';
      else { if (range.from > 0 && !source.slice(0, range.from).endsWith(eol + eol)) replacement = eol + eol + replacement; if (range.to < source.length && !source.slice(range.to).startsWith(eol + eol)) replacement += eol + eol; }
      editor.replace(source.slice(0, range.from) + replacement + source.slice(range.to), { from: range.from, to: range.from + replacement.length }); dialog.close(); editor.view.focus();
    } catch (error) { report(error); }
  });
  dialog.footer.append(apply); render();
}
