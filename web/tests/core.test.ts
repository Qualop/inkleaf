import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand } from '../core/commands.ts';
import type { Selection } from '../core/commands.ts';
import { parseTable, serializeTable, createTable, updateCell, insertRow, removeRow, moveRow, insertColumn, removeColumn, moveColumn, setAlignment } from '../core/tables.ts';
import { findMatches, replaceMatches } from '../core/search.ts';
import { getStatistics, getOutline } from '../core/statistics.ts';
import { parseFrontMatter } from '../core/metadata.ts';

// Fixtures are literal source and results, never computed with the operation under test.
const wrappers = [
  ['bold', '**한😀글**', 2, 6], ['italic', '*한😀글*', 1, 5],
  ['underline', '<u>한😀글</u>', 3, 7], ['strike', '~~한😀글~~', 2, 6],
  ['highlight', '==한😀글==', 2, 6], ['code', '`한😀글`', 1, 5],
  ['sup', '<sup>한😀글</sup>', 5, 9], ['sub', '<sub>한😀글</sub>', 5, 9],
  ['comment', '<!--한😀글-->', 4, 8], ['inlineMath', '$한😀글$', 1, 5],
] as const;
for (const [type, expected, from, to] of wrappers) {
  test(`${type} wraps literal Unicode with accurate selection`, () => {
    assert.deepEqual(applyCommand('한😀글', { from: 0, to: 4 }, { type }), { text: expected, selection: { from, to } });
  });
  test(`${type} toggles markers outside selection`, () => {
    assert.deepEqual(applyCommand(expected, { from, to }, { type }), { text: '한😀글', selection: { from: 0, to: 4 } });
  });
  test(`${type} toggles fully selected markers`, () => {
    assert.deepEqual(applyCommand(expected, { from: 0, to: expected.length }, { type }), { text: '한😀글', selection: { from: 0, to: 4 } });
  });
}
function commandCase(name: string, source: string, selection: Selection, type: string, expected: string, expectedSelection: Selection, value?: any) {
  test(name, () => assert.deepEqual(applyCommand(source, selection, { type, value }), { text: expected, selection: expectedSelection }));
}
commandCase('empty inline selection leaves caret inside markers', 'ab', { from: 1, to: 1 }, 'bold', 'a****b', { from: 3, to: 3 });
commandCase('code chooses longer fence for literal backtick', 'a`b', { from: 0, to: 3 }, 'code', '``a`b``', { from: 2, to: 5 });
commandCase('code pads unmatched literal edge backtick', '`a', { from: 0, to: 2 }, 'code', '`` `a ``', { from: 3, to: 5 });
for (let level = 1; level <= 6; level++) {
  commandCase(`heading ${level} applies only current line`, 'before\r\n한글\r\nafter', { from: 9, to: 9 }, 'heading', `before\r\n${'#'.repeat(level)} 한글\r\nafter`, { from: 10 + level, to: 10 + level }, level);
}
commandCase('heading switches level', '## title', { from: 3, to: 8 }, 'heading', '# title', { from: 2, to: 7 }, 1);
commandCase('heading toggles same level', '## title', { from: 3, to: 8 }, 'heading', 'title', { from: 0, to: 5 }, 2);
commandCase('quote excludes line at selection end', 'one\r\ntwo\r\nthree', { from: 0, to: 5 }, 'quote', '> one\r\ntwo\r\nthree', { from: 2, to: 7 });
commandCase('quote preserves nested quote', '> one', { from: 2, to: 5 }, 'quote', 'one', { from: 0, to: 3 });
commandCase('bullet preserves nesting and switches list kind', '  3. one\r\n  4. two', { from: 5, to: 18 }, 'bullet', '  - one\r\n  - two', { from: 4, to: 16 });
commandCase('ordered sequential numbering', 'one\ntwo', { from: 0, to: 7 }, 'ordered', '1. one\n2. two', { from: 3, to: 13 });
commandCase('task converts bullet', '- one', { from: 2, to: 5 }, 'task', '- [ ] one', { from: 6, to: 9 });
commandCase('task toggles to plain', '- [x] one', { from: 6, to: 9 }, 'task', 'one', { from: 0, to: 3 });
commandCase('toggleTask checks only affected task', '- [ ] one\r\n- [x] two', { from: 6, to: 9 }, 'toggleTask', '- [x] one\r\n- [x] two', { from: 6, to: 9 });
commandCase('toggleTask unchecks uppercase', '- [X] one', { from: 6, to: 9 }, 'toggleTask', '- [ ] one', { from: 6, to: 9 });
commandCase('toggleTask creates a task on plain text', 'one', { from: 0, to: 3 }, 'toggleTask', '- [ ] one', { from: 6, to: 9 });
commandCase('indent nested selected list', '- a\r\n- b', { from: 5, to: 8 }, 'indent', '- a\r\n  - b', { from: 7, to: 10 });
commandCase('outdent one tab', '\t- a', { from: 3, to: 4 }, 'outdent', '- a', { from: 2, to: 3 });
commandCase('outdent two spaces only', '    - a', { from: 6, to: 7 }, 'outdent', '  - a', { from: 4, to: 5 });
commandCase('horizontalRule replaces selection using CRLF', 'one\r\nx\r\ntwo', { from: 5, to: 6 }, 'horizontalRule', 'one\r\n---\r\ntwo', { from: 8, to: 8 });
commandCase('codeBlock wraps selected lines and language', 'one\r\ntwo', { from: 0, to: 8 }, 'codeBlock', '```ts\r\none\r\ntwo\r\n```', { from: 7, to: 15 }, 'ts');
commandCase('codeBlock uses safe fence length', '```\na', { from: 0, to: 5 }, 'codeBlock', '````\n```\na\n````', { from: 5, to: 10 });
commandCase('mathBlock wraps selection', 'x+y', { from: 0, to: 3 }, 'mathBlock', '$$\nx+y\n$$', { from: 3, to: 6 });
commandCase('toc inserts at caret', 'ab', { from: 1, to: 1 }, 'toc', 'a\n\n[TOC]\n\nb', { from: 8, to: 8 });
commandCase('yaml adds front matter and selects values', '# title', { from: 2, to: 2 }, 'yaml', '---\n\n---\n# title', { from: 4, to: 4 });
commandCase('yaml does not duplicate existing front matter', '---\ntitle: Mori\n---\nbody', { from: 22, to: 22 }, 'yaml', '---\ntitle: Mori\n---\nbody', { from: 4, to: 16 });
for (const value of ['note', 'tip', 'important', 'warning', 'caution']) {
  const prefix = `> [!${value.toUpperCase()}]\r\n> `;
  commandCase(`alert ${value} with CRLF`, '한글\r\n😀', { from: 0, to: 6 }, 'alert', `${prefix}한글\r\n> 😀`, { from: prefix.length, to: prefix.length + 8 }, value);
}
commandCase('link formats only selection', 'a label z', { from: 2, to: 7 }, 'link', 'a [label](https://a.test/x) z', { from: 3, to: 8 }, 'https://a.test/x');
commandCase('image escapes destination parentheses and spaces', 'alt', { from: 0, to: 3 }, 'image', '![alt](<a b(c).png>)', { from: 2, to: 5 }, 'a b(c).png');
commandCase('clearFormat removes known inline and line markup', '# **a** *b* ~~c~~ ==d== <u>e</u> [f](url) `g`', { from: 0, to: 45 }, 'clearFormat', 'a b c d e f g', { from: 0, to: 13 });
commandCase('clearFormat preserves unknown HTML and escaped syntax', '<custom>**a**</custom> \\*b\\*', { from: 0, to: 28 }, 'clearFormat', '<custom>a</custom> \\*b\\*', { from: 0, to: 24 });
commandCase('clearFormat stays within inline selection', '**a** **b**', { from: 6, to: 11 }, 'clearFormat', '**a** b', { from: 6, to: 7 });
commandCase('insertParagraphBefore inserts before current block', 'a\r\nb\r\n\r\nc', { from: 3, to: 4 }, 'insertParagraphBefore', '\r\n\r\na\r\nb\r\n\r\nc', { from: 0, to: 0 });
commandCase('insertParagraphAfter inserts after current block', 'a\nb\n\nc', { from: 2, to: 3 }, 'insertParagraphAfter', 'a\nb\n\n\n\nc', { from: 5, to: 5 });
commandCase('moveLineUp keeps CRLF and cursor', 'a\r\nb\r\nc', { from: 3, to: 4 }, 'moveLineUp', 'b\r\na\r\nc', { from: 0, to: 1 });
commandCase('moveLineDown preserves final newline', 'a\r\nb\r\nc\r\n', { from: 0, to: 1 }, 'moveLineDown', 'b\r\na\r\nc\r\n', { from: 3, to: 4 });
commandCase('move multiple lines down', 'a\nb\nc\nd', { from: 2, to: 5 }, 'moveLineDown', 'a\nd\nb\nc', { from: 4, to: 7 });
commandCase('move edge is no-op', 'a\nb', { from: 0, to: 1 }, 'moveLineUp', 'a\nb', { from: 0, to: 1 });
commandCase('deleteBlock removes paragraph only', 'a\nb\n\nc', { from: 2, to: 2 }, 'deleteBlock', '\nc', { from: 0, to: 0 });
commandCase('deleteBlock removes full fenced block', 'p\n\n```ts\na\n\nb\n```\n\nq', { from: 12, to: 12 }, 'deleteBlock', 'p\n\n\nq', { from: 3, to: 3 });
commandCase('deleteWord removes preceding Unicode word', '한글 hello', { from: 8, to: 8 }, 'deleteWord', '한글 ', { from: 3, to: 3 });
commandCase('deleteWord removes complete emoji', 'a😀', { from: 3, to: 3 }, 'deleteWord', 'a', { from: 1, to: 1 });
commandCase('deleteWord removes a selection', 'a 한글 z', { from: 2, to: 4 }, 'deleteWord', 'a  z', { from: 2, to: 2 });
commandCase('unknown command preserves source', ':::unknown\r\n😀', { from: 2, to: 2 }, 'custom', ':::unknown\r\n😀', { from: 2, to: 2 });
test('commands reject invalid bounds and values', () => {
  assert.throws(() => applyCommand('a', { from: -1, to: 0 }, { type: 'bold' }), RangeError);
  assert.throws(() => applyCommand('a', { from: 1, to: 0 }, { type: 'bold' }), RangeError);
  assert.throws(() => applyCommand('a', { from: 0, to: 1 }, { type: 'heading', value: 7 }), RangeError);
  assert.throws(() => applyCommand('a', { from: 0, to: 1 }, { type: 'alert', value: 'bad' }), RangeError);
  assert.throws(() => applyCommand('a', { from: 0, to: 1 }, { type: 'codeBlock', value: 'ts\nBAD' }), RangeError);
});

const table = { headers: ['A', 'B'], rows: [['a', 'b'], ['c', 'd']], alignments: ['left', 'right'] as ('left'|'right')[] };
test('parse table handles escaped pipes, code pipes, CRLF, alignment and empty cells', () => {
  assert.deepEqual(parseTable('| A\\|B | `a|b` | C |\r\n| :--- | :---: | ---: |\r\n| x | | z |\r\n| q | r | |'), {
    headers: ['A|B', '`a|b`', 'C'], rows: [['x', '', 'z'], ['q', 'r', '']], alignments: ['left', 'center', 'right'],
  });
});
test('parse table pads short rows and truncates extra cells', () => assert.deepEqual(parseTable('A | B\n--- | ---\nx\ny | z | extra'), { headers: ['A', 'B'], rows: [['x', ''], ['y', 'z']], alignments: [null, null] }));
test('parse table supports longer backtick runs and escaped backslashes', () => assert.deepEqual(parseTable('| ``a`|b`` | A |\n| --- | --- |\n| C\\\\ | D |'), { headers: ['``a`|b``', 'A'], rows: [['C\\', 'D']], alignments: [null, null] }));
test('parse table rejects non-table and mismatched separator width', () => {
  assert.equal(parseTable('hello\nworld'), null);
  assert.equal(parseTable('| a | b |\n| --- |'), null);
  assert.equal(parseTable('| a |\n| x |'), null);
});
test('serialize table literal canonical Markdown', () => assert.equal(serializeTable(table), '| A | B |\n| :--- | ---: |\n| a | b |\n| c | d |'));
test('serialize escapes pipes including code and preserves existing escapes', () => assert.equal(serializeTable({ headers: ['a|b', '`c|d`', 'a\\|b'], rows: [['', 'x\ny', 'z']], alignments: [null, 'center', null] }), '| a\\|b | `c\\|d` | a\\\\\\|b |\n| --- | :---: | --- |\n|  | x<br>y | z |'));
test('create table uses body row count and independent cells', () => assert.deepEqual(createTable(2, 2), { headers: ['', ''], rows: [['', ''], ['', '']], alignments: [null, null] }));
test('updateCell supports header row -1 and is immutable', () => {
  assert.deepEqual(updateCell(table, -1, 1, 'Z'), { headers: ['A', 'Z'], rows: [['a', 'b'], ['c', 'd']], alignments: ['left', 'right'] });
  assert.deepEqual(updateCell(table, 1, 0, 'Q'), { headers: ['A', 'B'], rows: [['a', 'b'], ['Q', 'd']], alignments: ['left', 'right'] });
  assert.deepEqual(table.rows, [['a', 'b'], ['c', 'd']]);
});
test('insertRow inserts an empty rectangle', () => assert.deepEqual(insertRow(table, 1).rows, [['a', 'b'], ['', ''], ['c', 'd']]));
test('removeRow supports last remaining body row', () => assert.deepEqual(removeRow({ ...table, rows: [['a', 'b']] }, 0).rows, []));
test('moveRow destination is final index', () => assert.deepEqual(moveRow(table, 0, 1).rows, [['c', 'd'], ['a', 'b']]));
test('moveRow defaults to one position down', () => assert.deepEqual(moveRow(table, 0).rows, [['c', 'd'], ['a', 'b']]));
test('insertColumn moves all rows and alignment together', () => assert.deepEqual(insertColumn(table, 1), { headers: ['A', '', 'B'], rows: [['a', '', 'b'], ['c', '', 'd']], alignments: ['left', null, 'right'] }));
test('removeColumn keeps rectangular shape', () => assert.deepEqual(removeColumn(table, 0), { headers: ['B'], rows: [['b'], ['d']], alignments: ['right'] }));
test('moveColumn moves headers, cells and alignment', () => assert.deepEqual(moveColumn(table, 0, 1), { headers: ['B', 'A'], rows: [['b', 'a'], ['d', 'c']], alignments: ['right', 'left'] }));
test('moveColumn defaults to next column', () => assert.deepEqual(moveColumn(table, 0), { headers: ['B', 'A'], rows: [['b', 'a'], ['d', 'c']], alignments: ['right', 'left'] }));
test('setAlignment is immutable', () => {
  assert.deepEqual(setAlignment(table, 1, 'center').alignments, ['left', 'center']);
  assert.deepEqual(table.alignments, ['left', 'right']);
});
test('table operations enforce indices and nonzero width', () => {
  assert.throws(() => createTable(0, 0), RangeError);
  assert.throws(() => createTable(-1, 2), RangeError);
  assert.throws(() => updateCell(table, -2, 0, 'x'), RangeError);
  assert.throws(() => updateCell(table, 0, 2, 'x'), RangeError);
  assert.throws(() => insertRow(table, 3), RangeError);
  assert.throws(() => removeRow(table, 2), RangeError);
  assert.throws(() => moveRow(table, 0, 2), RangeError);
  assert.throws(() => insertColumn(table, 3), RangeError);
  assert.throws(() => removeColumn(createTable(0, 1), 0), RangeError);
  assert.throws(() => moveColumn(table, 0, -1), RangeError);
  assert.throws(() => serializeTable({ ...table, rows: [['a']] }), RangeError);
});

test('literal search is case insensitive by default with UTF16 offsets', () => assert.deepEqual(findMatches('😀 Ab ab', 'ab'), [{ from: 3, to: 5 }, { from: 6, to: 8 }]));
test('literal search escapes metacharacters', () => assert.deepEqual(findMatches('a.b axb', 'a.b'), [{ from: 0, to: 3 }]));
test('case sensitive search', () => assert.deepEqual(findMatches('Ab ab', 'ab', { caseSensitive: true }), [{ from: 3, to: 5 }]));
test('regex search returns captures', () => assert.deepEqual(findMatches('a1 b22', '([a-z])(\\d+)', { regex: true }), [{ from: 0, to: 2, groups: ['a', '1'] }, { from: 3, to: 6, groups: ['b', '22'] }]));
test('whole word recognizes Unicode and combining marks', () => assert.deepEqual(findMatches('한 한글 한_ 한! e\u0301 e', '한', { wholeWord: true }), [{ from: 0, to: 1 }, { from: 8, to: 9 }]));
test('whole word excludes combining continuations', () => assert.deepEqual(findMatches('e\u0301 e', 'e', { wholeWord: true }), [{ from: 3, to: 4 }]));
test('whole word recognizes astral letters', () => assert.deepEqual(findMatches('𐐀cat cat𐐀 cat', 'cat', { wholeWord: true }), [{ from: 12, to: 15 }]));
test('zero-width regex safely advances Unicode code points', () => assert.deepEqual(findMatches('😀a', '(?=)', { regex: true }), [{ from: 0, to: 0, groups: [] }, { from: 2, to: 2, groups: [] }, { from: 3, to: 3, groups: [] }]));
test('empty literal query has no matches', () => assert.deepEqual(findMatches('abc', ''), []));
test('invalid regex throws explicit SyntaxError', () => assert.throws(() => findMatches('x', '[', { regex: true }), SyntaxError));
test('replace literal is literal including dollar markers and CRLF', () => assert.equal(replaceMatches('a\r\na', 'a', '$1'), '$1\r\n$1'));
test('replace regex expands captures and dollar escape', () => assert.equal(replaceMatches('a1 b22', '([a-z])(\\d+)', '$2:$1:$$:$&', { regex: true }), '1:a:$:a1 22:b:$:b22'));
test('replace regex supports named captures', () => assert.equal(replaceMatches('a1', '(?<letter>a)(?<n>1)', '$<n>$<letter>', { regex: true }), '1a'));
test('replace regex handles wholeWord excluded matches', () => assert.equal(replaceMatches('cat cats cat', '(cat)', '<$1>', { regex: true, wholeWord: true }), '<cat> cats <cat>'));
test('replace zero-width Unicode', () => assert.equal(replaceMatches('😀a', '(?=)', '-', { regex: true }), '-😀-a-'));
test('replacement supports prefix and suffix substitutions', () => assert.equal(replaceMatches('abc', 'b', "$`-$'", { regex: true }), 'aa-cc'));

test('statistics count Unicode code points and all whitespace', () => assert.deepEqual(getStatistics('한글 hello😀\r\nworld'), { words: 3, characters: 16, charactersNoSpaces: 13, lines: 2, readingMinutes: 1 }));
test('statistics empty text and final newline', () => {
  assert.deepEqual(getStatistics(''), { words: 0, characters: 0, charactersNoSpaces: 0, lines: 0, readingMinutes: 0 });
  assert.deepEqual(getStatistics('a\n', 1), { words: 1, characters: 2, charactersNoSpaces: 1, lines: 2, readingMinutes: 1 });
  assert.equal(getStatistics('one two three', 2).readingMinutes, 2);
  assert.throws(() => getStatistics('a', 0), RangeError);
});
test('outline ignores front matter, fences and uses stable duplicate Unicode IDs', () => {
  const source = '---\nlabel: yes\n---\n# 한글\n```md\n# hidden\n```\n## Hello *world*\n# 한글\n';
  assert.deepEqual(getOutline(source), [
    { level: 1, title: '한글', line: 4, from: 19, to: 23, id: '한글' },
    { level: 2, title: 'Hello world', line: 8, from: 43, to: 59, id: 'hello-world' },
    { level: 1, title: '한글', line: 9, from: 60, to: 64, id: '한글-1' },
  ]);
});
test('outline setext, CRLF, trailing hashes and tilde fences', () => assert.deepEqual(getOutline('Title\r\n=====\r\n~~~\r\n# hide\r\n~~~\r\n## End ##\r\n'), [
  { level: 1, title: 'Title', line: 1, from: 0, to: 12, id: 'title' },
  { level: 2, title: 'End', line: 6, from: 32, to: 41, id: 'end' },
]));
test('outline avoids anchor collisions with numbered titles', () => assert.deepEqual(getOutline('# a\n# a\n# a-1\n# a').map(h => h.id), ['a', 'a-1', 'a-1-1', 'a-2']));
test('outline rejects indented code and malformed heading', () => assert.deepEqual(getOutline('    # code\n#nospace\n'), []));
test('front matter parses scalar values without rewriting body', () => assert.deepEqual(parseFrontMatter('---\r\ntitle: "Mori: notes"\r\ndraft: false\r\ncount: 3\r\nempty: null\r\n---\r\n# 한😀\r\n'), { data: { title: 'Mori: notes', draft: false, count: 3, empty: null }, body: '# 한😀\r\n', range: { from: 0, to: 69 } }));
test('front matter supports nesting, lists and quoted comments', () => assert.deepEqual(parseFrontMatter('---\ntags: [one, "two, three"]\nauthor:\n  name: \'A # B\'\nitems:\n  - x\n  - y\n---\nbody'), { data: { tags: ['one', 'two, three'], author: { name: 'A # B' }, items: ['x', 'y'] }, body: 'body', range: { from: 0, to: 77 } }));
test('front matter absent or unclosed preserves complete source', () => {
  assert.deepEqual(parseFrontMatter('body\n---\ntitle: x'), { data: {}, body: 'body\n---\ntitle: x' });
  assert.deepEqual(parseFrontMatter('---\ntitle: x'), { data: {}, body: '---\ntitle: x' });
});
test('front matter allows BOM and empty metadata', () => assert.deepEqual(parseFrontMatter('\uFEFF---\n---\nx'), { data: {}, body: 'x', range: { from: 0, to: 9 } }));
test('front matter malformed data fails explicitly', () => assert.throws(() => parseFrontMatter('---\nno mapping\n---\nbody'), SyntaxError));
test('front matter does not assign prototype keys unsafely', () => {
  const result = parseFrontMatter('---\n__proto__: safe\nconstructor: value\n---\nx');
  assert.equal(Object.getPrototypeOf(result.data), Object.prototype);
  assert.equal(Object.hasOwn(result.data, '__proto__'), true);
  assert.equal(result.data.__proto__, 'safe');
});

commandCase('padded double code span toggles from selected content', '`` `a ``', { from: 3, to: 5 }, 'code', '`a', { from: 0, to: 2 });
commandCase('italic adds inside existing bold rather than removes one star', '**a**', { from: 2, to: 3 }, 'italic', '***a***', { from: 3, to: 4 });
commandCase('codeBlock selection ending at next line start remains bounded', 'one\r\ntwo', { from: 0, to: 5 }, 'codeBlock', '```\r\none\r\n```\r\ntwo', { from: 5, to: 8 });
commandCase('move last unterminated line up preserves final newline choice', 'a\r\nb', { from: 3, to: 4 }, 'moveLineUp', 'b\r\na', { from: 0, to: 1 });
commandCase('move lines across mixed endings maps cursor to moved text', 'a\nb\r\nc', { from: 2, to: 3 }, 'moveLineDown', 'a\nc\r\nb', { from: 5, to: 6 });
commandCase('deleteBlock in fenced blank line removes entire fence', 'p\n\n```\nx\n\ny\n```\n\nq', { from: 9, to: 9 }, 'deleteBlock', 'p\n\n\nq', { from: 3, to: 3 });
commandCase('clearFormat at caret preserves its logical character offset', '**hello**', { from: 4, to: 4 }, 'clearFormat', 'hello', { from: 2, to: 2 });
commandCase('clearFormat preserves code literals and underscores in words', '`**a**` snake_case', { from: 0, to: 17 }, 'clearFormat', '**a** snake_case', { from: 0, to: 15 });
commandCase('clearFormat preserves unknown control content', '\u00000\u0000 **a**', { from: 0, to: 9 }, 'clearFormat', '\u00000\u0000 a', { from: 0, to: 5 });
commandCase('clearFormat removes block quote and nested task together', '> - [x] **a**', { from: 0, to: 13 }, 'clearFormat', 'a', { from: 0, to: 1 });
commandCase('clearFormat removes a full fence without changing code content', '```ts\n**a**\n```', { from: 0, to: 15 }, 'clearFormat', '**a**', { from: 0, to: 5 });
commandCase('deleteWord removes family emoji as a grapheme', 'a👨‍👩‍👧‍👦', { from: 12, to: 12 }, 'deleteWord', 'a', { from: 1, to: 1 });
test('selection cannot split surrogate pairs or CRLF', () => {
  assert.throws(() => applyCommand('😀', { from: 1, to: 1 }, { type: 'bold' }), RangeError);
  assert.throws(() => applyCommand('a\r\nb', { from: 2, to: 2 }, { type: 'quote' }), RangeError);
});
test('table pipe parsing does not treat escaped closing backticks as a delimiter', () => assert.deepEqual(parseTable('| `a\\`|b` | C |\n| --- | --- |'), { headers: ['`a\\`|b`', 'C'], rows: [], alignments: [null, null] }));
test('table unmatched backtick does not swallow delimiter', () => assert.deepEqual(parseTable('| `a | b |\n| --- | --- |'), { headers: ['`a', 'b'], rows: [], alignments: [null, null] }));
test('table parse serialized escapes yields literal cell values', () => assert.deepEqual(parseTable('| a\\\\\\|b | `c\\|d` |\n| --- | --- |\n| x\\\\ | y |'), { headers: ['a\\|b', '`c|d`'], rows: [['x\\', 'y']], alignments: [null, null] }));
test('table empty header and empty cells stay rectangular', () => assert.deepEqual(parseTable('| | B |\n| --- | --- |\n| | |'), { headers: ['', 'B'], rows: [['', '']], alignments: [null, null] }));
test('table clone isolates unchanged nested rows', () => {
  const original = { headers: ['A'], rows: [['a']], alignments: [null] };
  const result = insertRow(original, 1);
  result.rows[0][0] = 'changed';
  assert.deepEqual(original, { headers: ['A'], rows: [['a']], alignments: [null] });
});
test('table alignment rejects unsupported values', () => assert.throws(() => setAlignment(table, 0, 'bad' as any), RangeError));
test('table last-index default moves are immutable no-ops', () => {
  assert.deepEqual(moveRow(table, 1), table);
  assert.deepEqual(moveColumn(table, 1), table);
});
test('search unmatched optional captures become empty groups', () => assert.deepEqual(findMatches('b', '(a)?b', { regex: true }), [{ from: 0, to: 1, groups: [''] }]));
test('replacement handles unavailable and two-digit captures correctly', () => {
  assert.equal(replaceMatches('a', '(a)', '$12/$2/$0/$01', { regex: true }), 'a2/$2/$0/a');
  assert.equal(replaceMatches('a', '(?<x>a)', '$<missing>', { regex: true }), '');
});
test('empty regex matches and replaces empty document once', () => {
  assert.deepEqual(findMatches('', '', { regex: true }), [{ from: 0, to: 0, groups: [] }]);
  assert.equal(replaceMatches('', '', 'x', { regex: true }), 'x');
});
test('replacement reports invalid regular expressions explicitly', () => assert.throws(() => replaceMatches('x', '[', 'y', { regex: true }), SyntaxError));
test('outline empty ATX titles have stable IDs and ignores unclosed fences', () => assert.deepEqual(getOutline('#\n#\n~~~\n# hide'), [
  { level: 1, title: '', line: 1, from: 0, to: 1, id: '' },
  { level: 1, title: '', line: 2, from: 2, to: 3, id: '-1' },
]));
test('outline closing fence must match marker and length', () => assert.deepEqual(getOutline('````\n# a\n```\n# b\n~~~~\n# c\n````\n# visible').map(h => h.title), ['visible']));
test('outline ignores block math headings', () => assert.deepEqual(getOutline('$$\n# hidden\n$$\n# visible').map(h => h.title), ['visible']));
test('front matter supports dates as strings, comments and single quote escapes', () => assert.deepEqual(parseFrontMatter("---\ndate: 2026-10-13\ntitle: 'it''s here' # comment\nurl: https://a/#x\n---\n").data, { date: '2026-10-13', title: "it's here", url: 'https://a/#x' }));
test('front matter supports literal and folded multiline strings', () => assert.deepEqual(parseFrontMatter('---\nliteral: |\n  one\n  two\nfolded: >-\n  three\n  four\n---\n').data, { literal: 'one\ntwo\n', folded: 'three four' }));
test('front matter rejects duplicate keys and unsupported aliases', () => {
  assert.throws(() => parseFrontMatter('---\na: 1\na: 2\n---\nx'), SyntaxError);
  assert.throws(() => parseFrontMatter('---\na: &anchor value\n---\nx'), SyntaxError);
});
test('front matter closing dots preserve exact body', () => assert.deepEqual(parseFrontMatter('---\na: 1\n...\n\nbody'), { data: { a: 1 }, body: '\nbody', range: { from: 0, to: 13 } }));
commandCase('clearFormat restores escaped punctuation within code', '`x\\*y`', { from: 0, to: 6 }, 'clearFormat', 'x\\*y', { from: 0, to: 4 });
commandCase('clearFormat keeps both escaped brackets in inline code', '`\\[a\\]` **b**', { from: 0, to: 13 }, 'clearFormat', '\\[a\\] b', { from: 0, to: 7 });
commandCase('move mixed-ending group maps both endpoints by line', 'a\r\nb\nc\r\nd', { from: 3, to: 6 }, 'moveLineDown', 'a\r\nd\nb\r\nc', { from: 5, to: 9 });
commandCase('moveLineDown selection including CRLF ends on moved line boundary', 'a\r\nb', { from: 0, to: 3 }, 'moveLineDown', 'b\r\na', { from: 3, to: 4 });
commandCase('deleteBlock groups multiline math across blank lines', 'p\n\n$$\na\n\nb\n$$\n\nq', { from: 9, to: 9 }, 'deleteBlock', 'p\n\n\nq', { from: 3, to: 3 });
commandCase('deleteBlock groups setext heading and underline', 'Title\n---\n\nbody', { from: 2, to: 2 }, 'deleteBlock', '\nbody', { from: 0, to: 0 });
commandCase('deleteBlock groups list item continuations and nested children', '- one\n  continuation\n  - nested\n- two', { from: 2, to: 2 }, 'deleteBlock', '- two', { from: 0, to: 0 });
commandCase('clearFormat removes setext underline', 'Title\r\n---', { from: 0, to: 10 }, 'clearFormat', 'Title', { from: 0, to: 5 });
test('table unmatched opener with only escaped backtick keeps column delimiters', () => assert.deepEqual(parseTable('| `a\\` | b |\n| --- | --- |'), { headers: ['`a\\`', 'b'], rows: [], alignments: [null, null] }));
test('front matter sequence mappings preserve structure', () => assert.deepEqual(parseFrontMatter('---\nauthors:\n  - name: Mori\n    active: true\n  - name: Notes\n    roles:\n      - writer\n      - reader\n---\n').data, { authors: [{ name: 'Mori', active: true }, { name: 'Notes', roles: ['writer', 'reader'] }] }));
test('front matter flow sequence empty items fail instead of disappearing', () => assert.throws(() => parseFrontMatter('---\na: [x,,y]\n---\n'), SyntaxError));
test('front matter keep chomping preserves trailing empty lines', () => assert.deepEqual(parseFrontMatter('---\na: |+\n  one\n\n---\n').data, { a: 'one\n\n' }));
test('front matter parses nested flow objects', () => assert.deepEqual(parseFrontMatter('---\na: {name: Mori, tags: [x, y]}\n---\n').data, { a: { name: 'Mori', tags: ['x', 'y'] } }));
commandCase('clearFormat preserves unmatched backtick run', '``a`', { from: 0, to: 4 }, 'clearFormat', '``a`', { from: 0, to: 4 });
commandCase('clearFormat preserves unmatched code delimiters with known formatting', '``a` **b**', { from: 0, to: 10 }, 'clearFormat', '``a` b', { from: 0, to: 6 });
commandCase('clearFormat preserves backslash in valid inline code', '`x\\*y` **b**', { from: 0, to: 12 }, 'clearFormat', 'x\\*y b', { from: 0, to: 6 });
commandCase('clearFormat removes valid triple delimiter code without losing inner ticks', '```a``b```', { from: 0, to: 10 }, 'clearFormat', 'a``b', { from: 0, to: 4 });
commandCase('link escapes label brackets and preserves selection', 'a[b]c', { from: 0, to: 5 }, 'link', '[a\\[b\\]c](url)', { from: 1, to: 8 }, 'url');
commandCase('image escapes literal backslash in label', 'a\\b', { from: 0, to: 3 }, 'image', '![a\\\\b](url)', { from: 2, to: 6 }, 'url');
commandCase('footnote moves selected source into a new definition', 'a note z', { from: 2, to: 6 }, 'footnote', 'a [^1] z\n\n[^1]: note', { from: 16, to: 20 });
commandCase('footnote inserts an empty definition at caret with CRLF', '한글\r\n', { from: 2, to: 2 }, 'footnote', '한글[^1]\r\n\r\n[^1]: \r\n', { from: 16, to: 16 });
commandCase('footnote allocates unused IDs and preserves unknown definitions', 'a\n\n[^1]: old', { from: 0, to: 1 }, 'footnote', '[^2]\n\n[^1]: old\n\n[^2]: a', { from: 23, to: 24 });
commandCase('footnote supports multiline Unicode body with indented continuation', '한\r\n😀', { from: 0, to: 5 }, 'footnote', '[^1]\r\n\r\n[^1]: 한\r\n    😀', { from: 14, to: 23 });
commandCase('reference link inserts an actual source definition', 'hello', { from: 0, to: 5 }, 'linkReference', '[hello][link-1]\n\n[link-1]: https://a.test', { from: 1, to: 6 }, 'https://a.test');
commandCase('reference link respects labels and CRLF/final newline', '한글\r\n', { from: 0, to: 2 }, 'linkReference', '[한글][docs]\r\n\r\n[docs]: <a b.md>\r\n', { from: 1, to: 3 }, { label: 'docs', url: 'a b.md' });
commandCase('reference link avoids existing labels', '[link-1]: old\n\nhello', { from: 15, to: 20 }, 'linkReference', '[link-1]: old\n\n[hello][link-2]\n\n[link-2]: new', { from: 16, to: 21 }, 'new');
test('reference commands reject duplicate or invalid explicit labels', () => {
  assert.throws(() => applyCommand('[^x]: old', { from: 0, to: 0 }, { type: 'footnote', value: 'x' }), RangeError);
  assert.throws(() => applyCommand('a', { from: 0, to: 1 }, { type: 'linkReference', value: { label: 'bad\nlabel', url: 'x' } }), RangeError);
});
