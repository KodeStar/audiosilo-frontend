import type { BookMetaRecap } from '@/api/types';

import {
  daysSince,
  overlapStart,
  PREVIOUSLY_ON_GAP_DAYS,
  previouslyOn,
  type PreviouslyOnInput,
} from './previously-on-model';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T08:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

// Ten chapters of 360 s; the listener is at 3570 s, in chapter 10.
const starts = Array.from({ length: 10 }, (_, i) => i * 360);
const recaps: BookMetaRecap[] = [
  { through: { chapter: 0 }, scope: 'series', text: 'Before: the war began.' },
  { through: { chapter: 8 }, scope: 'book', text: 'Up to 8: the shroud is stolen.' },
  { through: { chapter: 16 }, scope: 'book', text: 'Up to 16: a spoiler.' },
];

const input = (over: Partial<PreviouslyOnInput> = {}): PreviouslyOnInput => ({
  saved: { position: 3570, finished: false, updated_at: ago(14) },
  now: NOW,
  loaded: false,
  dismissed: false,
  metadata: true,
  recaps,
  chapterStarts: starts,
  ...over,
});

describe('previouslyOn', () => {
  it('shows after 12 days with the furthest recap the listener is past', () => {
    const card = previouslyOn(input());
    expect(card).toEqual({ days: 14, recap: recaps[1], chapter: 10 });
  });

  it('waits for a gap of 12 days', () => {
    expect(
      previouslyOn(input({ saved: { position: 3570, finished: false, updated_at: ago(11) } })),
    ).toBeNull();
    expect(
      previouslyOn(
        input({
          saved: { position: 3570, finished: false, updated_at: ago(PREVIOUSLY_ON_GAP_DAYS) },
        }),
      ),
    ).not.toBeNull();
  });

  it('never shows a recap past the listener (the Story so far gate)', () => {
    // At chapter 8 exactly, "up to 8" is not behind them yet: only the before-the-book one.
    const card = previouslyOn(
      input({ saved: { position: 7 * 360 + 10, finished: false, updated_at: ago(20) } }),
    );
    expect(card?.recap).toBe(recaps[0]);
  });

  it('has nothing to show without a recap that reaches the listener', () => {
    expect(previouslyOn(input({ recaps: [] }))).toBeNull();
    expect(previouslyOn(input({ recaps: [recaps[2]] }))).toBeNull();
  });

  it('is not for a finished, unstarted, loaded or dismissed book', () => {
    expect(
      previouslyOn(input({ saved: { position: 5000, finished: true, updated_at: ago(30) } })),
    ).toBeNull();
    expect(
      previouslyOn(input({ saved: { position: 0, finished: false, updated_at: ago(30) } })),
    ).toBeNull();
    expect(previouslyOn(input({ saved: undefined }))).toBeNull();
    expect(previouslyOn(input({ loaded: true }))).toBeNull();
    expect(previouslyOn(input({ dismissed: true }))).toBeNull();
  });

  it('needs the metadata capability (an older server, or not known yet)', () => {
    expect(previouslyOn(input({ metadata: false }))).toBeNull();
    expect(previouslyOn(input({ metadata: undefined }))).toBeNull();
  });
});

describe('helpers', () => {
  it('counts whole days, and nothing for a bad date', () => {
    expect(daysSince(ago(14), NOW)).toBe(14);
    expect(daysSince('nope', NOW)).toBeNull();
    expect(daysSince(undefined, NOW)).toBeNull();
  });

  it('starts 30 seconds early, never before the start', () => {
    expect(overlapStart(3570)).toBe(3540);
    expect(overlapStart(12)).toBe(0);
  });
});
