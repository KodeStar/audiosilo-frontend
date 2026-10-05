import { render, screen } from '@testing-library/react-native';

import type { Chapter, History } from '@/api/types';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/api/provider', () => ({ useCid: () => 'c1' }));

const mockHistory: History[] = [
  {
    id: 1,
    from_pos: 30,
    to_pos: 130,
    started_at: '2026-10-05T10:00:00Z',
    ended_at: '2026-10-05T10:02:00Z',
  } as History,
];
jest.mock('@/api/hooks', () => ({ useHistory: () => ({ data: mockHistory }) }));

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

describe('HistorySection', () => {
  it('names each position with the prettified chapter label, like every other surface', async () => {
    await render(
      <HistorySection
        libraryId={1}
        path="Tolkien/The Hobbit"
        chapters={[chapter(0, '01_the_hobbit_ch1.mp3', 0), chapter(1, '', 100)]}
      />,
    );
    // The start lands in the filename-titled chapter, the end in the untitled one.
    expect(screen.getByText('0:30 · 01 the hobbit ch1')).toBeTruthy();
    expect(screen.getByText('2:10 · Chapter 2')).toBeTruthy();
    expect(screen.queryByText(/\.mp3/)).toBeNull();
  });
});
