import type { Book, ChaptersResponse } from '@/api/types';

import {
  clampTranscodedSeek,
  codecLabel,
  EARLY_END_MIN_PROGRESS_S,
  EARLY_END_SLACK_S,
  isBrowserUndecodable,
  isEarlyTranscodeEnd,
  needsWebTranscode,
  transcodedTrackPosition,
  transcodeUrlAt,
} from './transcode';

function makeBook(p: Partial<Book> = {}): Book {
  return {
    id: 1,
    library_id: 2,
    rel_path: 'A/Book.m4b',
    is_folder: false,
    title: 'T',
    author: 'A',
    series: '',
    series_index: 0,
    narrator: '',
    duration: 100,
    format: 'm4b',
    size: 0,
    ...p,
  };
}

const chapters = (p: Partial<ChaptersResponse>): ChaptersResponse => ({
  library_id: 2,
  path: 'A/Book.m4b',
  duration: 100,
  is_folder: false,
  files: [],
  chapters: [],
  ...p,
});

describe('isBrowserUndecodable', () => {
  it('is true only for an explicit direct_playable false', () => {
    expect(isBrowserUndecodable(makeBook({ direct_playable: false }))).toBe(true);
    expect(isBrowserUndecodable(makeBook({ direct_playable: true }))).toBe(false);
    // An older server omits the field: stream as before.
    expect(isBrowserUndecodable(makeBook())).toBe(false);
  });

  it('prefers the chapters response when it carries the flag', () => {
    const book = makeBook({ direct_playable: true });
    expect(isBrowserUndecodable(book, chapters({ direct_playable: false }))).toBe(true);
    expect(
      isBrowserUndecodable(
        makeBook({ direct_playable: false }),
        chapters({ direct_playable: true }),
      ),
    ).toBe(false);
    // A chapters response without the flag falls back to the book's.
    expect(isBrowserUndecodable(makeBook({ direct_playable: false }), chapters({}))).toBe(true);
  });
});

describe('needsWebTranscode', () => {
  const undecodable = makeBook({ direct_playable: false });

  it('transcodes on web for an undecodable book when the server can', () => {
    expect(needsWebTranscode('web', undecodable, undefined, true)).toBe(true);
  });

  it('never transcodes on native', () => {
    expect(needsWebTranscode('ios', undecodable, undefined, true)).toBe(false);
    expect(needsWebTranscode('android', undecodable, undefined, true)).toBe(false);
  });

  it('streams directly when the server has no transcoder or its capability is unknown', () => {
    expect(needsWebTranscode('web', undecodable, undefined, false)).toBe(false);
    expect(needsWebTranscode('web', undecodable, undefined, undefined)).toBe(false);
  });

  it('streams a direct-playable (or unflagged) book directly', () => {
    expect(needsWebTranscode('web', makeBook({ direct_playable: true }), undefined, true)).toBe(
      false,
    );
    expect(needsWebTranscode('web', makeBook(), undefined, true)).toBe(false);
  });
});

describe('transcodeUrlAt', () => {
  const base = 'https://s/api/v1/libraries/2/stream?path=A%2FBook.m4b&transcode=1&token=abc';

  it('appends t, keeping every other param (the media token included)', () => {
    expect(transcodeUrlAt(base, 125.5)).toBe(`${base}&t=125.5`);
  });

  it('replaces an existing t rather than stacking another', () => {
    const at = transcodeUrlAt(base, 60);
    expect(transcodeUrlAt(at, 90)).toBe(`${base}&t=90`);
  });

  it('drops t at 0 (or a non-finite value): the stream starts at the top', () => {
    expect(transcodeUrlAt(`${base}&t=60`, 0)).toBe(base);
    expect(transcodeUrlAt(base, Number.NaN)).toBe(base);
  });

  it('rounds to milliseconds', () => {
    expect(transcodeUrlAt(base, 10.123456)).toBe(`${base}&t=10.123`);
  });

  it('does not touch a param that merely starts with t', () => {
    const url = 'https://s/stream?path=x&transcode=1&token=t%3D1';
    expect(transcodeUrlAt(url, 5)).toBe(`${url}&t=5`);
  });

  it('works on a url without a query', () => {
    expect(transcodeUrlAt('/stream', 5)).toBe('/stream?t=5');
    expect(transcodeUrlAt('/stream', 0)).toBe('/stream');
  });
});

describe('transcodedTrackPosition', () => {
  it('adds the request offset to the element time', () => {
    expect(transcodedTrackPosition(5, 300, 1000)).toBe(305);
  });

  it('clamps to the known duration and tolerates a bad currentTime', () => {
    expect(transcodedTrackPosition(5, 998, 1000)).toBe(1000);
    expect(transcodedTrackPosition(Number.NaN, 300, 1000)).toBe(300);
    expect(transcodedTrackPosition(5, 300)).toBe(305); // unknown duration: no clamp
  });
});

describe('clampTranscodedSeek', () => {
  it('clamps into [0, duration]', () => {
    expect(clampTranscodedSeek(-4, 100)).toBe(0);
    expect(clampTranscodedSeek(140, 100)).toBe(100);
    expect(clampTranscodedSeek(40, 100)).toBe(40);
    expect(clampTranscodedSeek(140)).toBe(140);
    expect(clampTranscodedSeek(Number.NaN, 100)).toBe(0);
  });
});

describe('isEarlyTranscodeEnd', () => {
  it('reads an end well before the known duration as the stream dying', () => {
    expect(isEarlyTranscodeEnd(400, 1000, null)).toBe(true);
  });

  it('accepts an end near the known duration as the file finishing', () => {
    expect(isEarlyTranscodeEnd(1000 - EARLY_END_SLACK_S + 1, 1000, null)).toBe(false);
  });

  it('needs a known duration', () => {
    expect(isEarlyTranscodeEnd(400, undefined, null)).toBe(false);
    expect(isEarlyTranscodeEnd(400, 0, null)).toBe(false);
  });

  it('retries again only after real progress past the last retry', () => {
    expect(isEarlyTranscodeEnd(401, 1000, 400)).toBe(false);
    expect(isEarlyTranscodeEnd(400 + EARLY_END_MIN_PROGRESS_S, 1000, 400)).toBe(true);
  });
});

describe('codecLabel', () => {
  it('names the common undecodable codecs and upper-cases the rest', () => {
    expect(codecLabel('ac3')).toBe('AC-3');
    expect(codecLabel('EAC3')).toBe('E-AC-3');
    expect(codecLabel('alac')).toBe('ALAC');
    expect(codecLabel('wmav2')).toBe('WMA');
    expect(codecLabel('ape')).toBe('APE');
  });

  it('is empty when the codec is unknown', () => {
    expect(codecLabel(undefined)).toBe('');
    expect(codecLabel('  ')).toBe('');
  });
});
