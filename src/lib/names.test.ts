import { foldAccents, initials } from '@/lib/names';

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
