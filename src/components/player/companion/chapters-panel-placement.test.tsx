import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { FlatList, Platform, type ViewInstance } from 'react-native';

import type { Chapter } from '@/api/types';
import { playerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('../transport', () => ({ trackLabel: () => '' }));
// Whether VoiceOver or TalkBack is on (screen-reader's own tests).
let mockScreenReader = false;
jest.mock('@/lib/screen-reader', () => ({
  ...jest.requireActual('@/lib/screen-reader'),
  useScreenReader: () => mockScreenReader,
}));

/* eslint-disable import/first */
import { createPageScroll, PageScrollContext } from '../page-scroll';
import { ChaptersPanel, chapterRowHeight } from './chapters-panel';
/* eslint-enable import/first */

const player = playerStoreMock();
const WINDOW = { nativeEvent: { layout: { width: 320, height: 600 } } };

/** `count` chapters of 100 s each (a hundred by default), the playhead `rows` chapters in. */
function open(rows: number, count = 100) {
  const chapters: Chapter[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `Chapter ${i + 1}`,
    file_index: 0,
    file_path: 'A/B/01.mp3',
    start: i * 100,
    end: (i + 1) * 100,
    book_offset: i * 100,
  }));
  player.reset();
  player.usePlayer.setState({
    nowPlaying: {
      connectionId: 'home',
      libraryId: 1,
      path: 'A/B',
      queue: { chapters, total: count * 100 },
    },
    bookPosition: rows * 100,
  });
}

describe('ChaptersPanel countdown', () => {
  // fe#197: the current row counts down as the seek row does (`wholeSecondsLeft`), so
  // 59.6 s left reads "-1:00" in both, never "-0:59" here beside "-1:00" there.
  it("rounds the current chapter's time left as the seek row does", async () => {
    const chapters: Chapter[] = [0, 1].map((i) => ({
      index: i,
      title: `Chapter ${i + 1}`,
      file_index: 0,
      file_path: 'A/B/01.mp3',
      start: i * 100.6,
      end: (i + 1) * 100.6,
      book_offset: i * 100.6,
    }));
    player.reset();
    player.usePlayer.setState({
      nowPlaying: {
        connectionId: 'home',
        libraryId: 1,
        path: 'A/B',
        queue: { chapters, total: 201.2 },
      },
      bookPosition: 41,
    });
    await render(<ChaptersPanel />);
    expect(screen.getByText('-1:00')).toBeTruthy();
  });
});

describe('ChaptersPanel placement', () => {
  const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset');
  beforeEach(() => scrollToOffset.mockClear());

  it('scrolls a list that opened at its top to the current row when first laid out', async () => {
    // Near the end the rows from the wanted one don't fill the window: no `initialScrollIndex`.
    open(95);
    await render(<ChaptersPanel virtualized />);
    const list = screen.getByTestId('chapters-list');
    await fireEvent(list, 'layout', WINDOW);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset.mock.calls[0][0].offset).toBeGreaterThan(80 * chapterRowHeight(1));
    await fireEvent(list, 'layout', WINDOW);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
  });

  it('never moves a list that opened at its row on a later layout', async () => {
    // Opened by `initialScrollIndex`; the playhead then reaches the end of the book, where a
    // list opens at its top. A rotation or a resized column must not pull the list there.
    open(52);
    await render(<ChaptersPanel virtualized />);
    const list = screen.getByTestId('chapters-list');
    await fireEvent(list, 'layout', WINDOW);
    await act(async () => {
      player.usePlayer.setState({ bookPosition: 9_500 });
    });
    await fireEvent(list, 'layout', { nativeEvent: { layout: { width: 600, height: 320 } } });
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
});

describe('ChaptersPanel in a sheet or column', () => {
  it("opens a long book's list on the current chapter", async () => {
    open(600.5, 1000);
    await render(<ChaptersPanel virtualized />);
    expect(screen.getByLabelText('Chapter 601, playing now')).toBeTruthy();
    expect(screen.queryByText('Chapter 1')).toBeNull();
  });
});

describe('ChaptersPanel inline in the page', () => {
  const ROW = chapterRowHeight(1);
  const { default: nativeMethods } = jest.requireActual<{
    default: { measureInWindow: jest.Mock };
  }>('@react-native/jest-preset/jest/MockNativeMethods');
  /** Where the list sits in the page's window (its top in the content: the page's origin is
   * at 0). */
  let listTop = 0;
  beforeEach(() => {
    listTop = 1000;
    nativeMethods.measureInWindow.mockImplementation((done: (x: number, y: number) => void) =>
      done(0, listTop),
    );
  });
  afterEach(() => {
    nativeMethods.measureInWindow.mockReset();
    mockScreenReader = false;
  });

  /** The panel inline in a page 800 high, laid out and measured. */
  async function inPage() {
    const page = createPageScroll();
    page.setOrigin({
      measureInWindow: (done: (x: number, y: number) => void) => done(0, 0),
    } as unknown as ViewInstance);
    await render(
      <PageScrollContext.Provider value={page.scroll}>
        <ChaptersPanel />
      </PageScrollContext.Provider>,
    );
    await act(async () =>
      page.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 700, height: 800 } },
      } as never),
    );
    const scrollTo = async (y: number) =>
      act(async () =>
        page.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } } as never),
      );
    return { page, scrollTo };
  }

  it('draws every row of a list of up to a hundred', async () => {
    open(3);
    await inPage();
    expect(screen.queryByTestId('chapters-page-rows')).toBeNull();
    expect(screen.getByText('Chapter 100')).toBeTruthy();
  });

  it("draws a long list's first rows, holding the room of the rest", async () => {
    open(600.5, 1000);
    await inPage();
    const rows = screen.getByTestId('chapters-page-rows');
    // The list starts 1000 down a page 800 high: its rows down to a page height below the
    // visible part (1600 into the page), rounded up to a step of 20.
    expect(screen.getByText('Chapter 1')).toBeTruthy();
    expect(screen.getByText('Chapter 20')).toBeTruthy();
    expect(screen.queryByText('Chapter 21')).toBeNull();
    expect(screen.queryByText('Chapter 601')).toBeNull();
    // The rest's room: one spacer after the drawn rows.
    const last = rows.children[rows.children.length - 1];
    expect(typeof last === 'string' ? null : last.props.style).toEqual({ height: 980 * ROW });
  });

  it('draws the current chapter, with its countdown, once the page is scrolled to it', async () => {
    open(600.5, 1000);
    const { scrollTo } = await inPage();
    await fireEvent(screen.getByTestId('chapters-page-rows'), 'layout', WINDOW);
    await scrollTo(listTop + 595 * ROW);
    expect(screen.getByLabelText('Chapter 601, playing now')).toBeTruthy();
    // 100 s chapters, 50 s in.
    expect(screen.getByText('-0:50')).toBeTruthy();
    expect(screen.queryByText('Chapter 1')).toBeNull();
    await fireEvent.press(screen.getByLabelText(/^Chapter 602, in /));
    expect(player.spies.seekBook).toHaveBeenCalledWith(60_100);
  });

  it('measures again when the content above it changes', async () => {
    open(0, 1000);
    const { page, scrollTo } = await inPage();
    await fireEvent(screen.getByTestId('chapters-page-rows'), 'layout', WINDOW);
    await scrollTo(listTop + 300 * ROW);
    expect(screen.getByText('Chapter 301')).toBeTruthy();
    // Something above the list grew by 200 rows' height: the web reports no layout for
    // the list, which only moved, but the page's content size changed.
    listTop += 200 * ROW;
    await act(async () => page.props.onContentSizeChange());
    expect(screen.getByText('Chapter 101')).toBeTruthy();
    expect(screen.queryByText('Chapter 301')).toBeNull();
  });

  it('draws every row of a long list with a screen reader on', async () => {
    mockScreenReader = true;
    open(3, 150);
    await inPage();
    expect(screen.queryByTestId('chapters-page-rows')).toBeNull();
    expect(screen.getByText('Chapter 150')).toBeTruthy();
  });

  it('draws every row of a long list on the web', async () => {
    // The web can't tell a screen reader is on, and a virtual cursor or find-in-page reaches
    // only the rows drawn.
    const os = Platform.OS;
    Platform.OS = 'web';
    try {
      open(3, 150);
      await inPage();
      expect(screen.queryByTestId('chapters-page-rows')).toBeNull();
      expect(screen.getByText('Chapter 150')).toBeTruthy();
    } finally {
      Platform.OS = os;
    }
  });

  it('draws every row with no page around it', async () => {
    open(3, 150);
    await render(<ChaptersPanel />);
    expect(screen.getByText('Chapter 150')).toBeTruthy();
  });
});
