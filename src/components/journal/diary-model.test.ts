import i18n from '@/i18n';

import type { Book, Bookmark, HistoryEntry } from '@/api/types';
import { contrast } from '@/components/series/spine-colors';
import { contentKey } from '@/lib/content-key';
import type { DriftRecord } from '@/playback/drift';

import { groupSessions, type ListeningSpan, localDayStart, toSpan } from '@/lib/listening-sessions';

import {
  barColor,
  dayBars,
  driftStrip,
  groupByDay,
  matchDrifts,
  MIN_BAR_WIDTH,
  spanRange,
} from './diary-model';
import type { Sourced } from './merge-model';

const t = i18n.t;
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const history = (
  id: number,
  start: number,
  end: number,
  from = 0,
  to = 600,
  book?: Partial<Book>,
): Sourced<HistoryEntry> => ({
  id,
  library_id: 1,
  path: 'Sanderson/Kings',
  from_pos: from,
  to_pos: to,
  started_at: iso(start),
  ended_at: iso(end),
  connectionId: 'c1',
  connectionName: 'Hearthside',
  ...(book ? { book: book as Book } : {}),
});

const span = (...args: Parameters<typeof history>) => toSpan(history(...args)) as ListeningSpan;

describe('groupByDay', () => {
  it('groups sessions by the local day they started, newest first, totalling the day', () => {
    const days = groupByDay(
      groupSessions([
        span(3, at(5, 21, 12), at(5, 21, 33)),
        span(2, at(5, 7, 42), at(5, 8, 15)),
        span(1, at(4, 22, 5), at(4, 22, 53)),
      ]),
    );
    expect(days.map((d) => d.start)).toEqual([localDayStart(at(5, 0)), localDayStart(at(4, 0))]);
    expect(days[0].sessions.map((s) => s.key)).toEqual(['c1\n3', 'c1\n2']);
    expect(days[0].total).toBe((21 + 33) * 60);
  });

  it('a session past midnight belongs to the day it started; the next day bar leaves it out', () => {
    const late = groupSessions([
      span(1, at(5, 23, 40), at(5, 23, 55), 0, 900),
      span(2, at(6, 0, 2), at(6, 0, 20), 900, 1980),
    ]);
    const days = groupByDay(late);
    expect(days.map((d) => d.start)).toEqual([localDayStart(at(5, 12))]);
    expect(days[0].spans).toHaveLength(2);
    // The span after midnight is not drawn on the start day's bar.
    expect(dayBars(days[0])).toHaveLength(1);
  });
});

describe('dayBars', () => {
  it('places each span by wall clock, in its cover accent', () => {
    const [day] = groupByDay(
      groupSessions([
        span(1, at(5, 12), at(5, 18), 0, 1, { cover_color: { bg: '#111111', accent: '#ff0000' } }),
      ]),
    );
    const [bar] = dayBars(day);
    expect(bar.left).toBeCloseTo(0.5);
    expect(bar.width).toBeCloseTo(0.25);
    expect(bar.cover).toEqual({ bg: '#111111', accent: '#ff0000' });
  });
  it('cuts a span at midnight, keeps a short one visible and falls back to no colour', () => {
    const [day] = groupByDay(
      groupSessions([span(1, at(5, 23, 30), at(6, 0, 30)), span(2, at(5, 6), at(5, 6, 1))]),
    );
    const bars = dayBars(day);
    expect(bars[0].width).toBe(MIN_BAR_WIDTH);
    expect(bars[0].cover).toBeUndefined();
    expect(bars[1].left + bars[1].width).toBeLessThanOrEqual(1);
    expect(bars[1].width).toBeCloseTo(0.5 / 24, 3);
  });
});

describe('spanRange', () => {
  it('names the chapters, once when the span stayed in one', () => {
    const names = (p: number) => (p < 100 ? 'Prelude' : 'Bridge Four');
    expect(spanRange({ from: 10, to: 200 }, names, t)).toBe('Prelude to Bridge Four');
    expect(spanRange({ from: 150, to: 200 }, names, t)).toBe('Bridge Four');
  });
  it('shows the positions while the chapters are not known', () => {
    expect(spanRange({ from: 61, to: 3725 }, () => null, t)).toBe('1:01 to 1:02:05');
  });
});

describe('drift-offs', () => {
  const ended = at(5, 23, 41);
  const s = span(1, at(5, 23, 0), ended, 1000, 3600);
  const bm = (over: Partial<Bookmark> = {}): Sourced<Bookmark> => ({
    id: 50,
    library_id: 1,
    path: 'Sanderson/Kings',
    position: 3600,
    note: 'Fell asleep',
    label: 'fell_asleep',
    created_at: iso(ended + 40_000),
    connectionId: 'c1',
    connectionName: 'Hearthside',
    ...over,
  });

  it('pairs the bookmark with the span it ended', () => {
    const other = span(2, at(5, 20), at(5, 20, 30), 0, 900);
    expect(matchDrifts([s, other], [bm()]).get(s.key)?.id).toBe(50);
  });
  it("pairs it with a session by the session's last span", () => {
    const [session] = groupSessions([span(0, at(5, 22, 30), at(5, 22, 59), 0, 1000), s]);
    expect(session.spans).toHaveLength(2);
    expect(matchDrifts([session], [bm()]).get(session.key)?.id).toBe(50);
  });
  it('ignores another book, another server, a far place or a much later bookmark', () => {
    expect(matchDrifts([s], [bm({ path: 'Other' })]).size).toBe(0);
    expect(matchDrifts([s], [{ ...bm(), connectionId: 'c2' }]).size).toBe(0);
    expect(matchDrifts([s], [bm({ position: 3600 + 20 * 60 })]).size).toBe(0);
    expect(matchDrifts([s], [bm({ created_at: iso(ended + 60 * 60_000) })]).size).toBe(0);
  });

  const record: DriftRecord = {
    touchAt: at(5, 23, 37),
    touchPosition: 3360,
    stoppedAt: 3600,
    recordedAt: ended + 40_000,
  };
  const key = contentKey('c1', 1, 'Sanderson/Kings');

  it("offers the jump back with this device's record", () => {
    expect(driftStrip(bm(), { [key]: record }, ended + 60_000)).toEqual({
      kind: 'jumpBack',
      minutes: 4,
      position: 3360,
      at: record.touchAt,
    });
  });
  it('without a record (or a stale or unrelated one), plays from the bookmark', () => {
    const plain = { kind: 'resume', position: 3600, at: ended + 40_000 };
    expect(driftStrip(bm(), {}, ended)).toEqual(plain);
    expect(driftStrip(bm(), { [key]: { ...record, stoppedAt: 9000 } }, ended)).toEqual(plain);
    expect(driftStrip(bm(), { [key]: record }, ended + 3 * 24 * 3600_000)).toEqual(plain);
  });
});

describe('barColor', () => {
  const LIGHT_TRACK = '#eef1f5';
  const DARK_TRACK = '#151d34';
  const LIGHT_FALLBACK = '#5b6680';
  const DARK_FALLBACK = '#8f9ab3';

  it('draws a span in its cover accent where it stands off the track', () => {
    expect(barColor({ bg: '#20304a', accent: '#e8649f' }, DARK_TRACK, DARK_FALLBACK)).toBe(
      '#e8649f',
    );
    expect(barColor({ bg: '#f4e9d0', accent: '#a3195a' }, LIGHT_TRACK, LIGHT_FALLBACK)).toBe(
      '#a3195a',
    );
  });

  // The web pass: a dark maroon accent was near-invisible on the dark theme's track.
  it('takes the dominant colour when the accent sinks into the track', () => {
    expect(barColor({ bg: '#e0c48a', accent: '#4a1020' }, DARK_TRACK, DARK_FALLBACK)).toBe(
      '#e0c48a',
    );
  });

  it('falls back to the theme token when neither colour stands off it', () => {
    expect(barColor({ bg: '#1a1630', accent: '#4a1020' }, DARK_TRACK, DARK_FALLBACK)).toBe(
      DARK_FALLBACK,
    );
    expect(barColor({ bg: '#f0f0f0', accent: '#fde8ea' }, LIGHT_TRACK, LIGHT_FALLBACK)).toBe(
      LIGHT_FALLBACK,
    );
    expect(barColor(undefined, DARK_TRACK, DARK_FALLBACK)).toBe(DARK_FALLBACK);
    expect(barColor({ bg: 'nope' }, DARK_TRACK, DARK_FALLBACK)).toBe(DARK_FALLBACK);
  });

  it('keeps every colour it picks at 3:1 against the track, in both themes', () => {
    const covers = [
      { bg: '#4a1020', accent: '#7a1f3d' },
      { bg: '#ffffff', accent: '#ffe066' },
      { bg: '#0d1b2a', accent: '#1b263b' },
      { bg: '#264653', accent: '#2a9d8f' },
    ];
    for (const [track, fallback] of [
      [LIGHT_TRACK, LIGHT_FALLBACK],
      [DARK_TRACK, DARK_FALLBACK],
    ]) {
      for (const cover of covers) {
        expect(contrast(barColor(cover, track, fallback), track)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
