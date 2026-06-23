import type { FsEntry } from '@/api/types';
import {
  filterEntries,
  groupByLetter,
  presentLetters,
  sectionIndexForLetter,
  sectionLetter,
} from '@/lib/alpha-sections';

function entry(name: string, isDir = true): FsEntry {
  return { name, path: name, is_dir: isDir, is_audio: !isDir, size: 0, mod_time: 0 };
}

describe('sectionLetter', () => {
  it('uppercases the first letter', () => {
    expect(sectionLetter('asimov')).toBe('A');
    expect(sectionLetter('Zelazny')).toBe('Z');
  });

  it('buckets digits, symbols and non-Latin starts under "#"', () => {
    expect(sectionLetter('3 Body Problem')).toBe('#');
    expect(sectionLetter('éclair')).toBe('#');
    expect(sectionLetter('')).toBe('#');
  });

  it('ignores leading whitespace', () => {
    expect(sectionLetter('  Banks')).toBe('B');
  });
});

describe('filterEntries', () => {
  const entries = [entry('Asimov'), entry('Bradbury'), entry('Le Guin')];

  it('matches a case-insensitive substring on the name', () => {
    expect(filterEntries(entries, 'gui').map((e) => e.name)).toEqual(['Le Guin']);
    expect(filterEntries(entries, 'A').map((e) => e.name)).toEqual(['Asimov', 'Bradbury']);
  });

  it('returns the input unchanged for a blank query', () => {
    expect(filterEntries(entries, '   ')).toBe(entries);
  });
});

describe('groupByLetter', () => {
  it('groups by first letter and keeps dirs before files within a letter', () => {
    // Server order: all directories (A–Z) then all files (A–Z).
    const entries = [
      entry('Adams'),
      entry('Asimov'),
      entry('Bradbury'),
      entry('another.mp3', false),
      entry('beta.mp3', false),
    ];
    const sections = groupByLetter(entries);
    expect(sections.map((s) => s.letter)).toEqual(['A', 'B']);
    expect(sections[0].data.map((e) => e.name)).toEqual(['Adams', 'Asimov', 'another.mp3']);
    expect(sections[1].data.map((e) => e.name)).toEqual(['Bradbury', 'beta.mp3']);
  });

  it('sorts the "#" bucket after the letters', () => {
    const sections = groupByLetter([entry('Apple'), entry('9 Lives', false)]);
    expect(sections.map((s) => s.letter)).toEqual(['A', '#']);
  });
});

describe('presentLetters', () => {
  it('reports the letters that have entries', () => {
    const set = presentLetters(groupByLetter([entry('Asimov'), entry('Zelazny')]));
    expect([...set].sort()).toEqual(['A', 'Z']);
  });
});

describe('sectionIndexForLetter', () => {
  const sections = groupByLetter([entry('Asimov'), entry('Banks'), entry('3 Body', false)]);
  // sections === [A, B, #]

  it('returns the matching section index', () => {
    expect(sectionIndexForLetter(sections, 'A')).toBe(0);
    expect(sectionIndexForLetter(sections, 'B')).toBe(1);
    expect(sectionIndexForLetter(sections, '#')).toBe(2);
  });

  it('snaps a missing letter forward to the next present section', () => {
    // No C…Z present, so the next group at/after them is "#".
    expect(sectionIndexForLetter(sections, 'C')).toBe(2);
    expect(sectionIndexForLetter(sections, 'Z')).toBe(2);
  });

  it('returns -1 when there are no sections', () => {
    expect(sectionIndexForLetter([], 'A')).toBe(-1);
  });
});
