import { render, screen } from '@testing-library/react-native';

// The episode wording only (BRIDGE-12); the tab's rows and timeline are covered through
// the book page's suite (book-page.test.tsx).

type TimelineProps = {
  current?: number;
  starts: number[];
  chapterAtSecond?: (seconds: number) => number;
};
const mockTimeline = jest.fn((_props: TimelineProps) => null);
jest.mock('@/components/player/book-timeline', () => ({
  BookTimeline: (p: TimelineProps) => mockTimeline(p),
}));
jest.mock('@/playback/store', () =>
  // `require` because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { BookChaptersTab, type BookChaptersTabProps } from './book-chapters-tab';
import type { ChapterList } from './book-page-model';
/* eslint-enable import/first */

const parts: ChapterList = {
  kind: 'parts',
  rows: [0, 1].map((i) => ({
    key: `p${i}`,
    index: i,
    title: '',
    start: i * 600,
    length: 600,
    jump: { position: i * 600 } as never,
  })),
};

const props = (over: Partial<BookChaptersTabProps> = {}): BookChaptersTabProps => ({
  list: parts,
  total: 1200,
  position: 0,
  current: 0,
  finished: false,
  loaded: false,
  pins: { bookmarks: [], notes: [] },
  roomy: false,
  interval: 600,
  source: undefined,
  onJump: jest.fn(),
  ...over,
});

it('says "book" for a book', async () => {
  await render(<BookChaptersTab {...props()} />);
  expect(screen.getByText('The whole book')).toBeTruthy();
  expect(screen.getByText('This book has no chapter marks')).toBeTruthy();
});

it('says "episode" on an episode page', async () => {
  await render(<BookChaptersTab {...props({ episode: true })} />);
  expect(screen.getByText('The whole episode')).toBeTruthy();
  expect(screen.getByText('This episode has no chapter marks')).toBeTruthy();
  expect(screen.queryByText('The whole book')).toBeNull();
});

it('marks no run current when a file of unknown length leaves the timeline one run', async () => {
  // A start after a file of unknown length is NaN: the timeline draws the book as one run,
  // so the row index names no run on it.
  const rows = parts.rows.map((r, i) => ({ ...r, start: i === 0 ? 0 : NaN }));
  await render(<BookChaptersTab {...props({ list: { kind: 'parts', rows }, current: 1 })} />);
  expect(mockTimeline.mock.lastCall?.[0]).toMatchObject({ starts: [], current: undefined });
});

it("names a hovered place's row as the rows mark it, past a zero-length marker", async () => {
  // Intro, two markers of no length at 30 s, then the chapter starting with them.
  const marks: [string, number, number][] = [
    ['Intro', 0, 30],
    ['Marker', 30, 0],
    ['Marker', 30, 0],
    ['Chapter One', 30, 90],
    ['Chapter Two', 120, 60],
  ];
  const rows = marks.map(([title, start, length], i) => ({
    key: `c${i}`,
    index: i,
    title,
    start,
    length,
    fileIndex: 0,
    jump: { position: start } as never,
  }));
  await render(
    <BookChaptersTab {...props({ list: { kind: 'chapters', rows }, total: 180, current: 0 })} />,
  );
  const timeline = mockTimeline.mock.lastCall?.[0];
  expect(timeline?.chapterAtSecond?.(45)).toBe(3);
  expect(timeline?.chapterAtSecond?.(10)).toBe(0);
});
