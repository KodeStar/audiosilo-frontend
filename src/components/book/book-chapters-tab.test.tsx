import { render, screen } from '@testing-library/react-native';

// The episode wording only (BRIDGE-12); the tab's rows and timeline are covered through
// the book page's suite (book-page.test.tsx).

jest.mock('@/components/player/book-timeline', () => ({ BookTimeline: () => null }));
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
