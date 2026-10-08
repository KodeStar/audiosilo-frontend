import type { TFunction } from 'i18next';
import i18next from 'i18next';

import type { Chapter } from '@/api/types';
import { playerHref } from '@/lib/paths';
import { playerStoreMock, type MockNowPlaying } from '@/testing/player-store-mock';

// The model reads the player through the store's selectors; the shared double is a real
// zustand store with the same selectors over a plain whole-book position.
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import {
  ACTIVITY_COVER_MAX,
  continueListeningProps,
  coverStem,
  emptyContinueListeningProps,
  fitsCover,
  hashKey,
  imageSize,
  JUMP_SECONDS,
  playerDeepLink,
  REFRESH_MS,
  sameActivity,
  sameTiming,
  sleepActivityProps,
  sleepTiming,
  WIDGET_COVER_MAX,
  writeDecision,
  type WidgetMark,
} from './widget-model';
/* eslint-enable import/first */

const player = playerStoreMock();
// eslint-disable-next-line import/no-named-as-default-member -- the i18next instance's `t`
const t = i18next.t.bind(i18next) as TFunction;
const NOW = 1_700_000_000_000;

function chapter(index: number, title: string, start: number, end: number): Chapter {
  return { index, title, file_index: 0, file_path: 'a.m4b', start, end, book_offset: start };
}

const CHAPTERS = [chapter(0, 'Opening', 0, 1200), chapter(1, '', 1200, 3600)];

/** A loaded book, with the fields the real `NowPlaying` has and the double leaves out. */
function load(position: number, state = 'playing', rate = 1) {
  const np = {
    connectionId: 'srv 1',
    libraryId: 3,
    path: 'Author/Book One',
    title: 'Book One',
    author: 'An Author',
    cover: '',
    queue: { chapters: CHAPTERS, total: 3600 },
  } as MockNowPlaying;
  player.reset();
  player.patch({
    nowPlaying: np,
    bookPosition: position,
    rate,
    snapshot: { state, trackIndex: 0, position, duration: 3600, rate },
  });
}

const state = () => player.usePlayer.getState() as never;

beforeEach(() => player.reset());

describe('playerDeepLink', () => {
  it('carries the book identity as the player route params, encoded', () => {
    expect(playerDeepLink('srv 1', 3, 'Author/Book & Co')).toBe(
      'audiosilo://player?connection=srv%201&libraryId=3&path=Author%2FBook%20%26%20Co',
    );
  });

  it("carries exactly the params the app's own player route uses", () => {
    const link = new URL(playerDeepLink('srv 1', 3, 'Author/Book & Co'));
    expect(link.host).toBe('player');
    expect(Object.fromEntries(link.searchParams)).toEqual(
      (playerHref('srv 1', 3, 'Author/Book & Co') as { params: Record<string, string> }).params,
    );
  });
});

describe('continueListeningProps', () => {
  it('is null with nothing loaded', () => {
    expect(continueListeningProps(state(), t, undefined)).toBeNull();
  });

  it('describes the loaded book at its speed', () => {
    load(1800, 'playing', 1.5);
    expect(continueListeningProps(state(), t, 'file:///g/cover-1-w.jpg')).toEqual({
      title: 'Book One',
      author: 'An Author',
      // The second chapter is untitled: the player's numbered label.
      chapterTitle: 'Chapter 2',
      coverFile: 'file:///g/cover-1-w.jpg',
      // 1800 book seconds at 1.5x.
      timeLeft: '20m left at 1.5×',
      progress: 0.5,
      isPlaying: true,
      deepLink: 'audiosilo://player?connection=srv%201&libraryId=3&path=Author%2FBook%20One',
      connectionId: 'srv 1',
      emptyText: 'Play a book and it shows up here.',
    });
  });

  it('leaves out what it does not know rather than sending undefined', () => {
    load(60, 'paused');
    const props = continueListeningProps(state(), t, undefined)!;
    expect('coverFile' in props).toBe(false);
    expect(props.isPlaying).toBe(false);
    expect(props.chapterTitle).toBe('Opening');
    expect(props.timeLeft).toBe('59m left');
  });

  it('has an empty form with just the localized line', () => {
    expect(emptyContinueListeningProps(t)).toEqual({
      emptyText: 'Play a book and it shows up here.',
    });
  });
});

describe('writeDecision', () => {
  const mark = (over: Partial<WidgetMark>): WidgetMark => ({
    bookKey: 'k',
    chapterIndex: 0,
    playing: true,
    rate: 1,
    position: 100,
    at: NOW,
    ...over,
  });

  it('writes the first book, and nothing before one is loaded', () => {
    expect(writeDecision(null, mark({}))).toBe('now');
    expect(writeDecision(null, mark({ bookKey: null }))).toBe('skip');
  });

  it('writes at once when what the widget shows changes in kind', () => {
    const last = mark({});
    expect(writeDecision(last, mark({ bookKey: 'other' }))).toBe('now');
    expect(writeDecision(last, mark({ bookKey: null }))).toBe('now'); // stopped
    expect(writeDecision(last, mark({ chapterIndex: 1 }))).toBe('now');
    expect(writeDecision(last, mark({ playing: false }))).toBe('now');
    expect(writeDecision(last, mark({ rate: 1.25 }))).toBe('now');
  });

  it('skips the progress ticks of steady playback, at any speed', () => {
    const last = mark({ rate: 2 });
    // 10 s later at 2x: 20 book seconds on.
    expect(writeDecision(last, mark({ rate: 2, position: 120, at: NOW + 10_000 }))).toBe('skip');
  });

  it('writes on a jump of more than JUMP_SECONDS, either way', () => {
    const last = mark({});
    expect(writeDecision(last, mark({ position: 100 + JUMP_SECONDS + 1, at: NOW + 100 }))).toBe(
      'now',
    );
    expect(writeDecision(last, mark({ position: 100 - JUMP_SECONDS - 1, at: NOW + 100 }))).toBe(
      'now',
    );
    // A paused book does not move, so a scrub while paused is a jump too.
    const paused = mark({ playing: false });
    expect(writeDecision(paused, mark({ playing: false, position: 200, at: NOW + 5000 }))).toBe(
      'now',
    );
  });

  it('refreshes a playing book once a minute, a paused one never', () => {
    const last = mark({});
    const later = NOW + REFRESH_MS;
    expect(writeDecision(last, mark({ position: 160, at: later }))).toBe('refresh');
    expect(writeDecision(last, mark({ position: 159, at: later - 1000 }))).toBe('skip');
    const paused = mark({ playing: false });
    expect(writeDecision(paused, mark({ playing: false, at: later * 2 }))).toBe('skip');
  });
});

describe('sleepTiming', () => {
  const KEY = 'srv 1:3:Author/Book One';
  const idle = {
    phase: 'idle',
    endsAt: null,
    frozenAt: null,
    pauseAtPosition: null,
    bookKey: null,
  } as const;

  it('is null unless a timer counts down towards a pause', () => {
    load(100);
    expect(sleepTiming(idle, state(), NOW)).toBeNull();
    expect(sleepTiming({ ...idle, phase: 'grace', bookKey: KEY }, state(), NOW)).toBeNull();
  });

  it('is null for a timer armed for another book', () => {
    load(100);
    const timer = { ...idle, phase: 'running', endsAt: NOW + 60_000, bookKey: 'x:1:y' } as const;
    expect(sleepTiming(timer, state(), NOW)).toBeNull();
  });

  it('shows a duration timer deadline as it is, frozen while paused', () => {
    load(100);
    const timer = { ...idle, phase: 'running', endsAt: NOW + 600_000, bookKey: KEY } as const;
    expect(sleepTiming(timer, state(), NOW)).toEqual({ endsAt: NOW + 600_000 });
    expect(sleepTiming({ ...timer, frozenAt: NOW - 5000 }, state(), NOW)).toEqual({
      endsAt: NOW + 600_000,
      pausedAt: NOW - 5000,
    });
  });

  it('turns an end-of-chapter target into a wall-clock end at the book speed', () => {
    // 1100 book seconds to the end of the first chapter, at 2x: 550 s of wall clock.
    load(100, 'playing', 2);
    const timer = { ...idle, phase: 'ending', pauseAtPosition: 1200, bookKey: KEY } as const;
    expect(sleepTiming(timer, state(), NOW)).toEqual({ endsAt: NOW + 550_000 });
  });

  it('freezes an end-of-chapter countdown while the book is paused', () => {
    load(100, 'paused', 1);
    const timer = { ...idle, phase: 'running', pauseAtPosition: 1200, bookKey: KEY } as const;
    expect(sleepTiming(timer, state(), NOW)).toEqual({ endsAt: NOW + 1_100_000, pausedAt: NOW });
  });

  it('moves the end with a seek and a speed change', () => {
    const timer = { ...idle, phase: 'running', pauseAtPosition: 1200, bookKey: KEY } as const;
    load(100, 'playing', 1);
    const before = sleepTiming(timer, state(), NOW)!;
    load(700, 'playing', 1); // seek on 600 s
    const seeked = sleepTiming(timer, state(), NOW)!;
    load(700, 'playing', 1.25);
    const faster = sleepTiming(timer, state(), NOW)!;
    expect(before.endsAt - seeked.endsAt).toBe(600_000);
    expect(faster.endsAt).toBe(NOW + 400_000);
    expect(sameTiming(before, seeked)).toBe(false);
  });
});

describe('sameTiming', () => {
  it('ignores progress-tick jitter but not a real move', () => {
    expect(sameTiming({ endsAt: NOW }, { endsAt: NOW + 1500 })).toBe(true);
    expect(sameTiming({ endsAt: NOW }, { endsAt: NOW + 2500 })).toBe(false);
  });

  it('compares frozen countdowns by what they show', () => {
    // The same 10 minutes left, re-anchored a minute later.
    expect(
      sameTiming(
        { endsAt: NOW + 600_000, pausedAt: NOW },
        { endsAt: NOW + 660_000, pausedAt: NOW + 60_000 },
      ),
    ).toBe(true);
    expect(sameTiming({ endsAt: NOW, pausedAt: NOW - 1 }, { endsAt: NOW })).toBe(false);
  });
});

describe('sleepActivityProps', () => {
  it('names the book, the chapter and the timer', () => {
    load(100);
    const timer = {
      phase: 'running',
      endsAt: NOW + 60_000,
      frozenAt: null,
      pauseAtPosition: null,
      bookKey: 'srv 1:3:Author/Book One',
    } as const;
    const timing = sleepTiming(timer, state(), NOW)!;
    const props = sleepActivityProps(timing, state(), t, 'file:///g/cover-1-a.jpg')!;
    expect(props).toEqual({
      title: 'Book One',
      chapterTitle: 'Opening',
      coverFile: 'file:///g/cover-1-a.jpg',
      endsAt: NOW + 60_000,
      deepLink: 'audiosilo://player?connection=srv%201&libraryId=3&path=Author%2FBook%20One',
      label: 'Sleep timer',
    });
    expect(sameActivity(props, { ...props, endsAt: props.endsAt + 1000 })).toBe(true);
    expect(sameActivity(props, { ...props, chapterTitle: 'Chapter 2' })).toBe(false);
    expect(sameActivity(props, { ...props, coverFile: undefined })).toBe(false);
  });
});

describe('covers', () => {
  it('names a book cover stably and safely', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'));
    expect(hashKey('abc')).not.toBe(hashKey('abd'));
    expect(hashKey('')).toMatch(/^[0-9a-f]{8}$/);
    expect(coverStem('srv', 1, 'A/B')).toMatch(/^cover-[0-9a-f]{8}$/);
    expect(coverStem('srv', 1, 'A/B')).not.toBe(coverStem('srv2', 1, 'A/B'));
  });

  /** A minimal JPEG header: SOI, an APP0 segment, then SOF0 with the size. */
  function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
    return new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00,
      0xff,
      sof,
      0x00,
      0x11,
      0x08,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      0x03,
      0,
      0,
      0,
      0,
    ]);
  }

  function png(width: number, height: number): Uint8Array {
    const b = new Uint8Array(32);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    return b;
  }

  it('reads the pixel size of a JPEG (baseline and progressive) and a PNG', () => {
    expect(imageSize(jpeg(320, 300))).toEqual({ width: 320, height: 300 });
    expect(imageSize(jpeg(2400, 2400, 0xc2))).toEqual({ width: 2400, height: 2400 });
    expect(imageSize(png(160, 160))).toEqual({ width: 160, height: 160 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(jpeg(320, 320).slice(0, 10))).toBeNull(); // truncated
  });

  it('accepts a thumbnail and refuses the full art', () => {
    expect(fitsCover(jpeg(320, 320), WIDGET_COVER_MAX)).toBe(true);
    expect(fitsCover(jpeg(2400, 2400), WIDGET_COVER_MAX)).toBe(false);
    expect(fitsCover(jpeg(320, 320), ACTIVITY_COVER_MAX)).toBe(false);
    expect(fitsCover(png(160, 160), ACTIVITY_COVER_MAX)).toBe(true);
    expect(fitsCover(new Uint8Array(0), WIDGET_COVER_MAX)).toBe(false);
  });
});
