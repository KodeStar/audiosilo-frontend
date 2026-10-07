import type { Book, MyBookmark, MyNote } from '@/api/types';

import {
  csvField,
  exportFileName,
  type ExportRow,
  exportRows,
  type ExportWords,
  localStamp,
  toCsv,
  toMarkdown,
  UTF8_BOM,
} from './export-format';
import type { Sourced } from './merge-model';

const words: ExportWords = {
  columns: {
    server: 'Server',
    kind: 'Type',
    book: 'Book',
    author: 'Author',
    position: 'Position',
    chapter: 'Chapter',
    label: 'Label',
    text: 'Text',
    created: 'Created',
  },
  kind: { bookmark: 'Bookmark', note: 'Note' },
  title: 'Journal',
  exported: 'Exported 7 October 2026',
};

const made = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  kind: 'bookmark',
  connectionId: 'c1',
  server: 'Hearthside',
  libraryId: 1,
  path: 'Sanderson/Kings',
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  position: 45667,
  chapter: 'Bridge Four',
  label: 'Quote',
  text: 'Life before death.',
  created: made(5, 21, 12),
  ...over,
});

describe('csvField (RFC 4180)', () => {
  it('leaves a plain field alone', () => {
    expect(csvField('Bridge Four')).toBe('Bridge Four');
    expect(csvField('')).toBe('');
  });
  it('quotes a field with a comma, a quote or a line break, doubling quotes', () => {
    expect(csvField('Life, death')).toBe('"Life, death"');
    expect(csvField('He said "no"')).toBe('"He said ""no"""');
    expect(csvField('one\ntwo')).toBe('"one\ntwo"');
    expect(csvField('one\r\ntwo')).toBe('"one\r\ntwo"');
  });
  it('defuses a field a spreadsheet would run as a formula', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+1')).toBe("'+1");
    expect(csvField('-2')).toBe("'-2");
    expect(csvField('@sum')).toBe("'@sum");
    expect(csvField('a=b')).toBe('a=b');
  });
  it('keeps accents and CJK as they are', () => {
    expect(csvField('Éowyn 王')).toBe('Éowyn 王');
  });
});

describe('toCsv', () => {
  it('starts with a UTF-8 BOM, has a header, ends every line with CRLF', () => {
    const csv = toCsv([row()], words, false);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toEqual([
      'Type,Book,Author,Position,Chapter,Label,Text,Created',
      `Bookmark,The Way of Kings,Brandon Sanderson,12:41:07,Bridge Four,Quote,Life before death.,${localStamp(made(5, 21, 12))}`,
      '',
    ]);
  });
  it('adds the server column when the rows come from several servers', () => {
    const csv = toCsv([row()], words, true);
    expect(csv.slice(1).split('\r\n')[0]).toBe(
      'Server,Type,Book,Author,Position,Chapter,Label,Text,Created',
    );
    expect(csv.slice(1).split('\r\n')[1].startsWith('Hearthside,Bookmark,')).toBe(true);
  });
  it('writes an empty label, chapter and author as empty fields, and a note with lines quoted', () => {
    const csv = toCsv(
      [row({ kind: 'note', label: undefined, chapter: undefined, author: '', text: 'a, "b"\nc' })],
      words,
      false,
    );
    expect(csv.slice(1).split('\r\n')[1]).toBe(
      `Note,The Way of Kings,,12:41:07,,,"a, ""b""\nc",${localStamp(made(5, 21, 12))}`,
    );
  });
  it('is a header alone with no rows', () => {
    expect(toCsv([], words, false)).toBe(
      `${UTF8_BOM}Type,Book,Author,Position,Chapter,Label,Text,Created\r\n`,
    );
  });
});

describe('toMarkdown', () => {
  it('groups by book (newest book first), each book in reading order', () => {
    const md = toMarkdown(
      [
        row({ position: 600, text: 'later in the book', created: made(6, 9) }),
        row({
          path: 'Weir/Hail',
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          created: made(5, 22),
          label: undefined,
          chapter: undefined,
          position: 61,
          text: 'Fist my bump.',
        }),
        row({
          kind: 'note',
          position: 30,
          label: undefined,
          chapter: undefined,
          text: 'Line one\n\nLine two',
          created: made(4, 8),
        }),
      ],
      words,
      false,
    );
    expect(md).toBe(
      [
        '# Journal',
        '',
        'Exported 7 October 2026',
        '',
        '## The Way of Kings',
        'Brandon Sanderson',
        '',
        `- **0:30** · Note · ${localStamp(made(4, 8))}`,
        '  Line one',
        '',
        '  Line two',
        `- **10:00** · Bookmark · Quote · Bridge Four · ${localStamp(made(6, 9))}`,
        '  later in the book',
        '',
        '## Project Hail Mary',
        'Andy Weir',
        '',
        `- **1:01** · Bookmark · ${localStamp(made(5, 22))}`,
        '  Fist my bump.',
        '',
      ].join('\n'),
    );
  });
  it('names the server beside the author when there are several, and keeps one book per server', () => {
    const md = toMarkdown(
      [row(), row({ connectionId: 'c2', server: "Maya's Shelf", text: 'the same book elsewhere' })],
      words,
      true,
    );
    expect(md).toContain('Brandon Sanderson · Hearthside');
    expect(md).toContain("Brandon Sanderson · Maya's Shelf");
    expect(md.match(/^## The Way of Kings$/gm)).toHaveLength(2);
  });
  it('folds a title with line breaks onto one line and skips an empty note body', () => {
    const md = toMarkdown([row({ title: 'Two\nlines', author: '', text: '   ' })], words, false);
    expect(md).toContain('## Two lines\n\n- **12:41:07**');
    expect(md).not.toContain('\n  \n');
  });
});

describe('exportRows', () => {
  const book = { title: 'The Way of Kings', author: 'Brandon Sanderson' } as Book;
  const names = {
    chapterAt: (cid: string, _lib: number, _path: string, pos: number) =>
      cid === 'c1' && pos > 100 ? 'Bridge Four' : undefined,
    labelName: (key: string | undefined) => (key === 'quote' ? 'Quote' : undefined),
  };
  const bookmark = (over: Partial<Sourced<MyBookmark>> = {}): Sourced<MyBookmark> => ({
    id: 1,
    library_id: 1,
    path: 'Sanderson/Kings',
    position: 500,
    note: 'Life before death.',
    label: 'quote',
    created_at: '2026-10-05T10:00:00Z',
    book,
    connectionId: 'c1',
    connectionName: 'Hearthside',
    ...over,
  });
  const note: Sourced<MyNote> = {
    id: 2,
    library_id: 1,
    path: 'Fiction/Unindexed Book',
    position: 20,
    body: 'A thought',
    created_at: '2026-10-06T10:00:00Z',
    updated_at: '2026-10-06T10:00:00Z',
    connectionId: 'c1',
    connectionName: 'Hearthside',
  };

  it('builds both lists newest first, naming labels and chapters where known', () => {
    const rows = exportRows([bookmark()], [note], names);
    expect(rows.map((r) => [r.kind, r.title, r.author, r.label, r.chapter, r.text])).toEqual([
      ['note', 'Unindexed Book', '', undefined, undefined, 'A thought'],
      [
        'bookmark',
        'The Way of Kings',
        'Brandon Sanderson',
        'Quote',
        'Bridge Four',
        'Life before death.',
      ],
    ]);
  });
  it("leaves an unknown label out and names a missing book by its path's leaf", () => {
    const [r] = exportRows([bookmark({ label: 'sparkle', book: undefined })], [], names);
    expect(r.label).toBeUndefined();
    expect(r.title).toBe('Kings');
  });
});

describe('exportFileName', () => {
  it('names the file by the local date', () => {
    expect(exportFileName('md', new Date(2026, 9, 7, 23, 59))).toBe('journal-2026-10-07.md');
    expect(exportFileName('csv', new Date(2026, 0, 2))).toBe('journal-2026-01-02.csv');
  });
});
