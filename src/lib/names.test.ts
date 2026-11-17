import i18n from '@/i18n';
import { foldAccents, initials, joinNames } from '@/lib/names';

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

describe('joinNames', () => {
  it("joins in the app's words (common.and)", () => {
    const t = i18n.getFixedT('en');
    expect(joinNames(['Evie', 'Ellis', 'Sam'], t)).toBe('Evie, Ellis and Sam');
    expect(joinNames(['Evie', 'Ellis'], t)).toBe('Evie and Ellis');
    expect(joinNames(['Evie'], t)).toBe('Evie');
    expect(joinNames([], t)).toBe('');
  });
});
