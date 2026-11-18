import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { FlatList } from 'react-native';

import type { Chapter } from '@/api/types';
import { playerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('../transport', () => ({ trackLabel: () => '' }));

/* eslint-disable import/first */
import { ChaptersPanel, chapterRowHeight } from './chapters-panel';
/* eslint-enable import/first */

const player = playerStoreMock();
const WINDOW = { nativeEvent: { layout: { width: 320, height: 600 } } };

/** A hundred chapters of 100 s each, the playhead `rows` chapters in. */
function open(rows: number) {
  const chapters: Chapter[] = Array.from({ length: 100 }, (_, i) => ({
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
      queue: { chapters, total: 10_000 },
    },
    bookPosition: rows * 100,
  });
}

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
