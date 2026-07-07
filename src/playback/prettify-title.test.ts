import { prettifyChapterTitle } from './prettify-title';

describe('prettifyChapterTitle', () => {
  it('strips an audio extension', () => {
    expect(prettifyChapterTitle('chapter-01.mp3')).toBe('chapter-01');
    expect(prettifyChapterTitle('The Hobbit.m4b')).toBe('The Hobbit');
  });

  it('turns underscores into spaces', () => {
    expect(prettifyChapterTitle('01_the_hobbit_ch1.mp3')).toBe('01 the hobbit ch1');
    expect(prettifyChapterTitle('part_one')).toBe('part one');
  });

  it('collapses whitespace introduced by cleanup', () => {
    expect(prettifyChapterTitle('a__b___c.opus')).toBe('a b c');
  });

  it('leaves real metadata titles untouched', () => {
    expect(prettifyChapterTitle('Chapter 1')).toBe('Chapter 1');
    expect(prettifyChapterTitle('The Shadow of the Past')).toBe('The Shadow of the Past');
    // Hyphens and dots inside a genuine title are preserved.
    expect(prettifyChapterTitle('Mother-in-law')).toBe('Mother-in-law');
    expect(prettifyChapterTitle('3.5 The Interlude')).toBe('3.5 The Interlude');
    // A bitrate-looking number in a genuine (non-filename) title is left alone.
    expect(prettifyChapterTitle('Chapter 64')).toBe('Chapter 64');
  });

  it('strips a trailing bitrate token from filename-shaped labels', () => {
    expect(prettifyChapterTitle('wonderland_ch_01_64kb.mp3')).toBe('wonderland ch 01');
    // Unit variants and an internal space between number and unit.
    expect(prettifyChapterTitle('story_part2_128 kbps.mp3')).toBe('story part2');
    expect(prettifyChapterTitle('intro_32k.mp3')).toBe('intro');
  });

  it('only strips the bitrate token when it is trailing', () => {
    // "64kb" mid-filename is not the final token, so it survives.
    expect(prettifyChapterTitle('64kb_wonderland_ch_01.mp3')).toBe('64kb wonderland ch 01');
  });

  it('keeps the pre-strip value when stripping would empty the string', () => {
    expect(prettifyChapterTitle('_64kb.mp3')).toBe('64kb');
  });

  it('handles empty and whitespace input without throwing', () => {
    expect(prettifyChapterTitle('')).toBe('');
    expect(prettifyChapterTitle('   ')).toBe('   ');
  });

  it('falls back to the original when cleanup empties the string', () => {
    expect(prettifyChapterTitle('_.mp3')).toBe('_.mp3');
  });

  it('recognizes uppercase extensions', () => {
    expect(prettifyChapterTitle('TRACK01.MP3')).toBe('TRACK01');
  });
});
