import { bookLabels, labelKey } from './labels';

describe('labelKey', () => {
  it('compares labels by trimmed, collapsed, lower-cased name', () => {
    expect(labelKey('  Science   Fiction ')).toBe('science fiction');
    expect(labelKey('FANTASY')).toBe(labelKey('fantasy'));
  });
});

describe('bookLabels', () => {
  it("is the book's genres or tags, none from an older server", () => {
    const book = { genres: ['Fantasy'], tags: ['to-read'] };
    expect(bookLabels(book, 'genre')).toEqual(['Fantasy']);
    expect(bookLabels(book, 'tag')).toEqual(['to-read']);
    expect(bookLabels({}, 'genre')).toEqual([]);
  });
});
