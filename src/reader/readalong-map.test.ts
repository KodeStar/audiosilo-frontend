import {
  cfiAt,
  checkReadalongSpan,
  hasSpans,
  MAX_READALONG_CFI_BYTES,
  parseReadalongMap,
  readerMapOf,
} from './readalong-map';

// The player's check of a read-along map (Bridge Phase 3c): the server checks only its head,
// so every span is checked here, field by field.

const head = {
  format: 'audiosilo-readalong/v1',
  ebook: { file: 'Book.epub', sha256: 'f'.repeat(64) },
  audio: { duration: 84702.74, files: [{ path: 'Book.m4b', duration: 84702.737 }] },
  granularity: 'sentence',
  generator: { name: 'audiosilo-bridge', version: '0.5.0', aligner: 'whisper-words/1' },
  generated_at: '2026-11-02T10:11:12Z',
  coverage: { text: 0.996, audio: 0.987 },
};
const span = (start: number, end: number, cfi = 'epubcfi(/6/4[ch01]!/4/2,/1:0,/1:118)') => ({
  cfi,
  start,
  end,
});

describe('checkReadalongSpan', () => {
  it('takes a CFI of at most 1024 bytes and finite times with 0 <= start <= end', () => {
    expect(checkReadalongSpan(span(31.2, 37.85))).toEqual(span(31.2, 37.85));
    expect(checkReadalongSpan({ ...span(0, 0), extra: 1 })).toEqual(span(0, 0));
    const longest = `epubcfi(${'a'.repeat(MAX_READALONG_CFI_BYTES - 9)})`;
    expect(checkReadalongSpan(span(1, 2, longest))).not.toBeNull();
    // Counted in UTF-8 bytes: a two-byte character tips it over.
    const over = `epubcfi(${'a'.repeat(MAX_READALONG_CFI_BYTES - 10)}é)`;
    expect(checkReadalongSpan(span(1, 2, over))).toBeNull();
  });

  it.each([
    ['not an object', 'epubcfi(/6/4)'],
    ['a start after its end', span(2, 1)],
    ['a negative start', span(-0.1, 1)],
    ['a NaN time', span(Number.NaN, 1)],
    ['an infinite end', span(0, Infinity)],
    ['a string time', { cfi: 'epubcfi(/6/4)', start: '1', end: 2 }],
    ['no epubcfi(', span(1, 2, '/6/4!/4/2')],
    ['an unclosed CFI', span(1, 2, 'epubcfi(/6/4')],
    ['no CFI', { start: 1, end: 2 }],
  ])('refuses %s', (_, v) => {
    expect(checkReadalongSpan(v)).toBeNull();
  });
});

describe('parseReadalongMap', () => {
  it('keeps the head and the good spans, drops the bad ones and the gaps, and counts them', () => {
    const map = parseReadalongMap({
      ...head,
      sections: [
        {
          href: 'Text/ch01.xhtml',
          spans: [span(1, 2), span(5, 3), 'junk'],
          gaps: [{ cfi: 'epubcfi(/6/4!/4/40)', chars: 212 }],
        },
        { href: 42, spans: [span(7, 8)] },
        { href: 'Text/ch02.xhtml' },
        { href: 'Text/ch03.xhtml', spans: [] },
      ],
      audio_gaps: [{ start: 0, end: 21.4 }],
    });
    expect(map).toEqual({
      ...head,
      generator: { name: 'audiosilo-bridge', version: '0.5.0' },
      sections: [
        { href: 'Text/ch01.xhtml', spans: [span(1, 2)] },
        { href: 'Text/ch03.xhtml', spans: [] },
      ],
      dropped: 3,
    });
    expect(hasSpans(map!)).toBe(true);
    expect(readerMapOf(map!)).toEqual({
      sections: [
        { href: 'Text/ch01.xhtml', spans: [span(1, 2)] },
        { href: 'Text/ch03.xhtml', spans: [] },
      ],
    });
  });

  it('is no map without the exact format or a sections array', () => {
    expect(parseReadalongMap(null)).toBeNull();
    expect(parseReadalongMap('{}')).toBeNull();
    expect(
      parseReadalongMap({ ...head, format: 'audiosilo-readalong/v2', sections: [] }),
    ).toBeNull();
    expect(parseReadalongMap({ ...head, sections: {} })).toBeNull();
  });

  it('reads a head with missing or odd fields as empty, never failing the map', () => {
    const map = parseReadalongMap({
      format: 'audiosilo-readalong/v1',
      coverage: { text: 7, audio: 'x' },
      audio: { duration: -1, files: [{ path: 'a', duration: 1 }, { path: 2 }] },
      sections: [],
    });
    expect(map).toMatchObject({
      ebook: { file: '', sha256: '' },
      audio: { duration: 0, files: [{ path: 'a', duration: 1 }] },
      coverage: { text: 1, audio: 0 },
      generated_at: '',
      dropped: 0,
    });
    expect(hasSpans(map!)).toBe(false);
  });
});

describe('cfiAt', () => {
  const map = {
    sections: [
      { href: 'a.xhtml', spans: [{ cfi: 'epubcfi(/6/2!/4/2)', start: 5, end: 9 }] },
      {
        href: 'b.xhtml',
        spans: [
          { cfi: 'epubcfi(/6/4!/4/2)', start: 20, end: 25 },
          { cfi: 'epubcfi(/6/4!/4/4)', start: 12, end: 19 },
        ],
      },
    ],
  };
  it('names the latest sentence starting at or before the time, in time order', () => {
    expect(cfiAt(map, 13)).toBe('epubcfi(/6/4!/4/4)');
    expect(cfiAt(map, 20)).toBe('epubcfi(/6/4!/4/2)');
    expect(cfiAt(map, 9.5)).toBe('epubcfi(/6/2!/4/2)');
  });
  it('names nothing before the first sentence', () => {
    expect(cfiAt(map, 1)).toBeUndefined();
  });
});
