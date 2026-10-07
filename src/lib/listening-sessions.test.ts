import type { Book, HistoryEntry } from '@/api/types';

import {
  dayName,
  groupSessions,
  type ListeningSpan,
  localDayStart,
  reachedEnd,
  SESSION_GAP_MS,
  sessionFinished,
  sessionMinutes,
  toSpan,
} from './listening-sessions';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const history = (
  id: number,
  start: number,
  end: number,
  from = 0,
  to = 600,
  book?: Partial<Book>,
): HistoryEntry & { connectionId: string; connectionName: string } => ({
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

describe('toSpan', () => {
  it('parses the times and keys the span by server and id', () => {
    const s = span(7, at(5, 21, 12), at(5, 21, 33), 100, 200);
    expect(s).toMatchObject({ key: 'c1\n7', start: at(5, 21, 12), from: 100, to: 200 });
    expect(s.bookKey).toBe('c1:1:Sanderson/Kings');
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
    const other = (id: number, start: number, end: number) =>
      toSpan({ ...history(id, start, end, 0, 300), path: 'Weir/Hail' }) as ListeningSpan;
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
    const b = toSpan({ ...history(2, at(5, 9, 6), at(5, 9, 9), 300, 480), connectionId: 'c2' })!;
    expect(groupSessions([a, b])).toHaveLength(2);
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

describe('reachedEnd', () => {
  it('needs the book length, and an end within 30 s of it', () => {
    expect(reachedEnd({ to: 3590, book: { duration: 3600 } as Book })).toBe(true);
    expect(reachedEnd({ to: 3500, book: { duration: 3600 } as Book })).toBe(false);
    expect(reachedEnd({ to: 3600 })).toBe(false);
  });
});
