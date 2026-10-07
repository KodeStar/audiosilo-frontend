import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Chapter, History } from '@/api/types';
import { formatWallClock } from '@/lib/format';

jest.mock('@/api/provider', () => ({ useCid: () => 'c1' }));
const mockJump = jest.fn();
// The book's chapters as its own read has them (`useChapterNamer`), named by the pure
// namer's parts (that module's hooks reach the player store, so it is rebuilt here).
let mockChapters: Chapter[] | undefined;
jest.mock('@/components/annotations', () => {
  const { chapterStartsOf } = jest.requireActual('@/components/library/meta-gating');
  const { chapterLabel } = jest.requireActual('@/lib/chapter-label');
  const { chapterAt } = jest.requireActual('@/playback/book-queue');
  const { t } = jest.requireActual('@/i18n').default;
  return {
    useJumpTo: () => mockJump,
    useChapterNamer: () => (position: number) => {
      if (!mockChapters?.length) return null;
      const starts: number[] = chapterStartsOf(mockChapters, []);
      const placed = mockChapters.map((ch, i) => ({ ...ch, book_offset: starts[i] }));
      return chapterLabel(chapterAt(placed, position), t);
    },
  };
});

let mockHistory: { data?: History[]; isError?: boolean; refetch?: jest.Mock } = {};
jest.mock('@/api/hooks', () => ({ useHistory: () => mockHistory }));

/* eslint-disable import/first */
import { HistorySection } from './history-section';
/* eslint-enable import/first */

const chapter = (index: number, title: string, bookOffset: number): Chapter => ({
  index,
  title,
  file_index: index,
  file_path: `${title}`,
  start: 0,
  end: 100,
  book_offset: bookOffset,
});

const now = new Date();
const startedToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
const row = (over: Partial<History> = {}): History => ({
  id: 1,
  library_id: 1,
  path: 'Tolkien/The Hobbit',
  from_pos: 30,
  to_pos: 130,
  started_at: startedToday.toISOString(),
  ended_at: new Date(startedToday.getTime() + 21 * 60_000).toISOString(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockHistory = { data: [row()] };
  mockChapters = undefined;
});

describe('HistorySection', () => {
  it('shows the day and time, where it went with the chapter it ended in, and its minutes', async () => {
    mockChapters = [chapter(0, '01_the_hobbit_ch1.mp3', 0), chapter(1, '', 100)];
    await render(<HistorySection libraryId={1} path="Tolkien/The Hobbit" />);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText(formatWallClock(startedToday))).toBeTruthy();
    // The end lands in the untitled chapter; filenames never show.
    expect(screen.getByText('0:30 to 2:10 · Chapter 2')).toBeTruthy();
    expect(screen.getByText('21 min')).toBeTruthy();
    expect(screen.queryByText(/\.mp3|×/)).toBeNull();
  });

  it('shows the positions alone without chapters, and jumps to where the span ended', async () => {
    await render(<HistorySection libraryId={1} path="Tolkien/The Hobbit" />);
    expect(screen.getByText('0:30 to 2:10')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Jump to 2:10'));
    expect(mockJump).toHaveBeenCalledWith(
      { connectionId: 'c1', libraryId: 1, path: 'Tolkien/The Hobbit' },
      130,
    );
  });

  it('shows one row per session: spans across short pauses joined, a seek starting another', async () => {
    const t0 = startedToday.getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    mockHistory = {
      data: [
        // Newest first, as the server sends them.
        row({
          id: 3,
          from_pos: 5000,
          to_pos: 5300,
          started_at: iso(t0 + 40 * 60_000),
          ended_at: iso(t0 + 45 * 60_000),
        }),
        row({
          id: 2,
          from_pos: 130,
          to_pos: 400,
          started_at: iso(t0 + 23 * 60_000),
          ended_at: iso(t0 + 28 * 60_000),
        }),
        row(),
      ],
    };
    await render(<HistorySection libraryId={1} path="Tolkien/The Hobbit" />);
    expect(screen.getAllByText('Jump')).toHaveLength(2);
    // 21 + 5 minutes listened, from 0:30 to 6:40.
    expect(screen.getByText('0:30 to 6:40')).toBeTruthy();
    expect(screen.getByText('26 min')).toBeTruthy();
    expect(screen.getByText('1:23:20 to 1:28:20')).toBeTruthy();
  });

  it("hands the jump to the caller's onJump (the player seeks in place)", async () => {
    const onJump = jest.fn();
    await render(<HistorySection libraryId={1} path="x" onJump={onJump} />);
    await fireEvent.press(screen.getByLabelText('Jump to 2:10'));
    expect(onJump).toHaveBeenCalledWith(130);
    expect(mockJump).not.toHaveBeenCalled();
  });

  it('names an older day by its short date', async () => {
    const old = new Date(2025, 2, 2, 22, 20);
    mockHistory = {
      data: [
        row({
          started_at: old.toISOString(),
          ended_at: new Date(old.getTime() + 60_000).toISOString(),
        }),
      ],
    };
    await render(<HistorySection libraryId={1} path="x" />);
    expect(screen.queryByText('Today')).toBeNull();
    expect(screen.getByText(/Mar/)).toBeTruthy();
  });

  it('with an empty label: loading, failed (with retry) and empty states', async () => {
    mockHistory = { data: undefined };
    const view = await render(
      <HistorySection libraryId={1} path="x" emptyLabel="No history yet." />,
    );
    expect(screen.queryByText('No history yet.')).toBeNull();

    const refetch = jest.fn();
    mockHistory = { data: undefined, isError: true, refetch };
    await view.rerender(<HistorySection libraryId={1} path="x" emptyLabel="No history yet." />);
    await fireEvent.press(screen.getByText('Retry'));
    expect(refetch).toHaveBeenCalled();

    mockHistory = { data: [] };
    await view.rerender(<HistorySection libraryId={1} path="x" emptyLabel="No history yet." />);
    expect(screen.getByText('No history yet.')).toBeTruthy();
  });

  it('renders nothing inline when empty', async () => {
    mockHistory = { data: [] };
    const view = await render(<HistorySection libraryId={1} path="x" />);
    expect(view.toJSON()).toBeNull();
  });
});
