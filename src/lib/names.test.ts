import { foldAccents, initials, joinList } from '@/lib/names';

describe('foldAccents', () => {
  it('removes accents and keeps everything else', () => {
    expect(foldAccents('Émile Lagerlöf')).toBe('Emile Lagerlof');
    expect(foldAccents('田中 晴美')).toBe('田中 晴美');
  });
});

describe('initials', () => {
  it('takes the first person and their first and last initials', () => {
    expect(initials('James S. A. Corey')).toBe('JC');
    expect(initials('Michael Kramer, Kate Reading')).toBe('MK');
    expect(initials('Michael Kramer & Kate Reading')).toBe('MK');
    expect(initials('Homer')).toBe('H');
    expect(initials('Naomi')).toBe('N');
    expect(initials('  ')).toBe('?');
    expect(initials('田中 晴美')).toBe('田晴');
  });
});

describe('joinList', () => {
  const and = (rest: string, last: string) => `${rest} and ${last}`;
  it('joins with commas and the locale joiner', () => {
    expect(joinList([], and)).toBe('');
    expect(joinList(['Fiction'], and)).toBe('Fiction');
    expect(joinList(['Fiction', 'Kids'], and)).toBe('Fiction and Kids');
    expect(joinList(['Fiction', 'Kids', 'Podcasts'], and)).toBe('Fiction, Kids and Podcasts');
  });

  it("joins people the same way (a device's household members)", () => {
    expect(joinList(['Evie'], and)).toBe('Evie');
    expect(joinList(['Evie', 'Ellis'], and)).toBe('Evie and Ellis');
    expect(joinList(['Evie', 'Ellis', 'Sam'], and)).toBe('Evie, Ellis and Sam');
  });
});
