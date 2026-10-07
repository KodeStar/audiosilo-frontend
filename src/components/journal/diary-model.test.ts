import i18n from '@/i18n';

import type { Book, Bookmark, HistoryEntry } from '@/api/types';
import { contentKey } from '@/lib/content-key';
import type { DriftRecord } from '@/playback/drift';

import {
  dayBars,
  dayName,
  type DiarySpan,
  driftStrip,
  groupByDay,
  localDayStart,
  matchDrifts,
  MIN_BAR_WIDTH,
  reachedEnd,
  groupSessions,
  sessionFinished,
  sessionMinutes,
  SESSION_GAP_MS,
  spanRange,
  toSpan,
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

const span = (...args: Parameters<typeof history>) => toSpan(history(...args)) as DiarySpan;

describe('toSpan', () => {
  it('parses the times and keys the span by server and id', () => {
    const s = span(7, at(5, 21, 12), at(5, 21, 33), 100, 200);
    expect(s).toMatchObject({ key: 'c1\n7', start: at(5, 21, 12), from: 100, to: 200 });
  });
  it('drops a row whose times cannot be read', () => {
    expect(toSpan({ ...history(1, 0, 0), started_at: 'nope' })).toBeNull();
  });
});

describe('groupSessions', () => {
  // A span per pause, as the server records them: contiguous positions, short gaps.
  const evening = [
    span(1, at(5, 21, 0), at(5, 21, 10), 0, 600),
    span(2, at(5, 21, 12), at(5, 21, 20), 610, 1090),
    span(3, at(5, 21, 25), at(5, 21, 40), 1090, 1990),
  ];

  it('joins the spans of one evening into one session', () => {
    const [s] = groupSessions(evening);
    expect(groupSessions(evening)).toHaveLength(1);
    expect(s).toMatchObject({
      key: 'c1\n1',
      start: at(5, 21, 0),
      end: at(5, 21, 40),
      from: 0,
      to: 1990,
    });
    expect(s.spans.map((p) => p.key)).toEqual(['c1\n1', 'c1\n2', 'c1\n3']);
    // Listened, not the wall clock with its pauses: 10 + 8 + 15 minutes.
    expect(s.listened).toBe(33 * 60);
    expect(sessionMinutes(s)).toBe(33);
  });

  it('splits at a pause of 10 minutes or more, joins one just under', () => {
    const first = span(1, at(5, 9, 0), at(5, 9, 10), 0, 600);
    const under = span(2, at(5, 9, 10) + SESSION_GAP_MS - 1000, at(5, 9, 30), 600, 900);
    const at10 = span(2, at(5, 9, 10) + SESSION_GAP_MS, at(5, 9, 30), 600, 900);
    expect(groupSessions([first, under])).toHaveLength(1);
    expect(groupSessions([first, at10])).toHaveLength(2);
  });

  it('splits after a seek (positions not contiguous), allows two minutes of slack', () => {
    const first = span(1, at(5, 9, 0), at(5, 9, 10), 0, 600);
    expect(groupSessions([first, span(2, at(5, 9, 11), at(5, 9, 20), 720, 900)])).toHaveLength(1);
    expect(groupSessions([first, span(2, at(5, 9, 11), at(5, 9, 20), 3000, 3500)])).toHaveLength(2);
    expect(groupSessions([first, span(2, at(5, 9, 11), at(5, 9, 20), 100, 400)])).toHaveLength(2);
  });

  it('keeps books apart, and another book in between ends the session', () => {
    const other = (id: number, start: number, end: number) => ({
      ...span(id, start, end, 0, 300),
      path: 'Weir/Hail',
    });
    const sessions = groupSessions([
      span(1, at(5, 9, 0), at(5, 9, 5), 0, 300),
      other(2, at(5, 9, 6), at(5, 9, 8)),
      span(3, at(5, 9, 9), at(5, 9, 14), 300, 600),
    ]);
    expect(sessions.map((s) => s.spans.map((p) => p.key))).toEqual([
      ['c1\n3'],
      ['c1\n2'],
      ['c1\n1'],
    ]);
  });

  it('keeps servers apart', () => {
    const a = span(1, at(5, 9, 0), at(5, 9, 5), 0, 300);
    const b = { ...span(2, at(5, 9, 6), at(5, 9, 9), 300, 480), connectionId: 'c2', key: 'c2\n2' };
    expect(groupSessions([a, b])).toHaveLength(2);
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

  it('counts the session finished when any span reached the end', () => {
    const book = { duration: 2000 } as Book;
    const [s] = groupSessions([
      span(1, at(5, 9, 0), at(5, 9, 10), 1400, 1990, book),
      span(2, at(5, 9, 11), at(5, 9, 12), 1990, 1995, book),
    ]);
    expect(sessionFinished(s)).toBe(true);
    expect(sessionFinished({ ...s, book: undefined })).toBe(false);
    expect(sessionFinished({ ...s, book: undefined }, book)).toBe(true);
  });

  it('counts a very short session as one minute', () => {
    expect(sessionMinutes(groupSessions([span(1, at(5, 9), at(5, 9) + 5_000)])[0])).toBe(1);
  });
});

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
});

describe('dayName', () => {
  const now = at(7, 15);
  it('names today, yesterday, this week by weekday, then by date', () => {
    expect(dayName(localDayStart(at(7, 1)), now)).toBe('today');
    expect(dayName(localDayStart(at(6, 23)), now)).toBe('yesterday');
    expect(dayName(localDayStart(at(1, 12)), now)).toBe('weekday');
    // Day 0 of October: 30 September, a week before.
    expect(dayName(localDayStart(at(0, 12)), now)).toBe('date');
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
    expect(bar.color).toBe('#ff0000');
  });
  it('cuts a span at midnight, keeps a short one visible and falls back to no colour', () => {
    const [day] = groupByDay(
      groupSessions([span(1, at(5, 23, 30), at(6, 0, 30)), span(2, at(5, 6), at(5, 6, 1))]),
    );
    const bars = dayBars(day);
    expect(bars[0].width).toBe(MIN_BAR_WIDTH);
    expect(bars[0].color).toBeUndefined();
    expect(bars[1].left + bars[1].width).toBeLessThanOrEqual(1);
    expect(bars[1].width).toBeCloseTo(0.5 / 24, 3);
  });
});

describe('reachedEnd', () => {
  it('needs the book length, and an end within 30 s of it', () => {
    expect(reachedEnd({ to: 3590, book: { duration: 3600 } as Book })).toBe(true);
    expect(reachedEnd({ to: 3500, book: { duration: 3600 } as Book })).toBe(false);
    expect(reachedEnd({ to: 3600 })).toBe(false);
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
