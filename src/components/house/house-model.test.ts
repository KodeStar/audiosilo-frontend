import type { HouseListening, HouseListeningRow } from '@/api/types';
import i18n from '@/i18n';

import {
  chapterName,
  daysAgo,
  houseCardWidth,
  houseColumns,
  houseCopy,
  houseWhen,
  rowsForBook,
  visibleRows,
} from './house-model';

const t = i18n.t.bind(i18n);

/** A local wall-clock time (the rules count local calendar days). */
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function row(over: Partial<HouseListeningRow> = {}): HouseListeningRow {
  return {
    user_id: 3,
    username: 'sam',
    library_id: 1,
    path: 'Will Wight/Unsouled',
    title: 'Unsouled',
    author: 'Will Wight',
    state: 'playing',
    position: 1234.5,
    duration: 36000,
    chapter: null,
    chapter_index: 3,
    updated_at: iso(local(9, 20)),
    ...over,
  };
}

describe('daysAgo', () => {
  it('counts local calendar days, not 24-hour spans', () => {
    const now = local(9, 0, 10);
    expect(daysAgo(iso(local(9, 0, 5)), now)).toBe(0);
    // Twenty minutes ago, but before midnight: yesterday.
    expect(daysAgo(iso(local(8, 23, 50)), now)).toBe(1);
    expect(daysAgo(iso(local(7, 12)), now)).toBe(2);
  });

  it('reads a save from a clock ahead of ours as today, and an unreadable time as null', () => {
    expect(daysAgo(iso(local(10, 9)), local(9, 22))).toBe(0);
    expect(daysAgo('not a time', local(9, 22))).toBeNull();
  });
});

describe('houseWhen', () => {
  const now = local(9, 21);
  it('keeps the server’s playing and paused', () => {
    expect(houseWhen(row({ state: 'playing' }), now)).toBe('playing');
    expect(houseWhen(row({ state: 'paused' }), now)).toBe('paused');
  });

  it('turns recent into today, yesterday or earlier by the local day', () => {
    expect(houseWhen(row({ state: 'recent', updated_at: iso(local(9, 8)) }), now)).toBe('today');
    expect(houseWhen(row({ state: 'recent', updated_at: iso(local(8, 23)) }), now)).toBe(
      'yesterday',
    );
    expect(houseWhen(row({ state: 'recent', updated_at: iso(local(6, 23)) }), now)).toBe('earlier');
    expect(houseWhen(row({ state: 'recent', updated_at: 'garbage' }), now)).toBe('today');
  });
});

describe('visibleRows', () => {
  const house = (listening: HouseListeningRow[], sharing = true): HouseListening => ({
    sharing,
    listening,
  });

  it('shows nothing while the caller does not share, or before an answer', () => {
    expect(visibleRows(house([row()]), false)).toEqual([]);
    // A cached answer from before the caller turned sharing off.
    expect(visibleRows(house([row()], false), true)).toEqual([]);
    expect(visibleRows(undefined, true)).toEqual([]);
  });

  it('keeps one row per person, the newest (first), in the server’s order', () => {
    const newest = row({ user_id: 3, title: 'Newest' });
    const older = row({ user_id: 3, title: 'Older' });
    const maya = row({ user_id: 5, username: 'maya' });
    expect(visibleRows(house([newest, maya, older]), true)).toEqual([newest, maya]);
  });
});

describe('rowsForBook', () => {
  it('matches on the library and the path together', () => {
    const here = row();
    const otherLibrary = row({ user_id: 4, library_id: 2 });
    const otherBook = row({ user_id: 5, path: 'Will Wight/Soulsmith' });
    expect(rowsForBook([here, otherLibrary, otherBook], 1, 'Will Wight/Unsouled')).toEqual([here]);
    expect(rowsForBook([here], 1, 'Will Wight')).toEqual([]);
  });
});

describe('chapterName', () => {
  it('prefers the title, then the 1-based number, else nothing', () => {
    expect(chapterName({ chapter: '14. Bridge Four', chapter_index: 13 }, t)).toBe(
      '14. Bridge Four',
    );
    expect(chapterName({ chapter: null, chapter_index: 3 }, t)).toBe('Chapter 4');
    expect(chapterName({ chapter: null, chapter_index: null }, t)).toBeNull();
  });
});

describe('houseCopy', () => {
  const now = local(9, 21);
  it('says who is listening to what, with the chapter', () => {
    const copy = houseCopy(row(), now, t);
    expect(copy.title).toBe('Unsouled');
    expect(copy.line).toBe('Listening now · Chapter 4');
    expect(copy.label).toBe('sam is listening to Unsouled, Chapter 4');
  });

  it('has a line for each state', () => {
    expect(houseCopy(row({ state: 'paused' }), now, t).line).toBe('Paused · Chapter 4');
    const today = row({ state: 'recent', updated_at: iso(local(9, 7)), chapter_index: null });
    expect(houseCopy(today, now, t)).toMatchObject({
      line: 'Earlier today',
      label: 'sam listened to Unsouled earlier today',
    });
    const yesterday = row({ state: 'recent', updated_at: iso(local(8, 22)) });
    expect(houseCopy(yesterday, now, t)).toMatchObject({
      line: 'Yesterday · Chapter 4',
      label: 'sam listened to Unsouled yesterday, Chapter 4',
    });
  });

  it('falls back to the path’s last segment for a missing title', () => {
    expect(houseCopy(row({ title: '' }), now, t).title).toBe('Unsouled');
  });
});

describe('the Home grid', () => {
  it('fits cards at least 250 wide, one on a phone or before measuring', () => {
    expect(houseColumns(0, false)).toBe(1);
    expect(houseColumns(1200, true)).toBe(1);
    expect(houseColumns(511, false)).toBe(1);
    expect(houseColumns(512, false)).toBe(2);
    expect(houseColumns(1100, false)).toBe(4);
  });

  it('splits the width between the columns, floored so the last card never wraps', () => {
    expect(houseCardWidth(0, false)).toBeUndefined();
    expect(houseCardWidth(400, true)).toBe(400);
    expect(houseCardWidth(513, false)).toBe(250);
    const w = houseCardWidth(1101, false)!;
    expect(4 * w + 3 * 12).toBeLessThanOrEqual(1101);
  });
});
