import { CLOTH_COLORS, clothColor, hashString, titleMonogram } from './monogram';

describe('titleMonogram', () => {
  it('takes the first letters of the first two words', () => {
    expect(titleMonogram('Blood Rites')).toBe('BR');
    expect(titleMonogram("Caliban's War")).toBe('CW');
  });

  it('skips small words, but not a title made only of them', () => {
    expect(titleMonogram('The Way of Kings')).toBe('WK');
    expect(titleMonogram('A Study in Scarlet')).toBe('SS');
    expect(titleMonogram('The')).toBe('T');
  });

  it('gives one letter for one word and skips leading punctuation', () => {
    expect(titleMonogram('Frankenstein')).toBe('F');
    expect(titleMonogram('"Quiet" Hours')).toBe('QH');
    expect(titleMonogram('Ember & Ash')).toBe('EA');
  });

  it('keeps accented letters and unspaced scripts whole', () => {
    expect(titleMonogram('Émile et ses amis')).toBe('ÉE');
    expect(titleMonogram('吾輩は猫である')).toBe('吾');
  });

  it("is '?' for an empty title", () => {
    expect(titleMonogram('')).toBe('?');
    expect(titleMonogram('  -- ')).toBe('?');
  });
});

describe('clothColor', () => {
  it('is one of the cloth colours and stable for a title', () => {
    expect(CLOTH_COLORS).toContain(clothColor('Blood Rites'));
    expect(clothColor('Blood Rites')).toBe(clothColor('Blood Rites'));
    expect(clothColor('Blood Rites')).toBe(
      CLOTH_COLORS[hashString('Blood Rites') % CLOTH_COLORS.length],
    );
  });
});

describe('hashString', () => {
  it('is stable per string and tells neighbours apart', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});
