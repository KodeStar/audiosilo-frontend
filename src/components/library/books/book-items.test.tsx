import { render, screen } from '@testing-library/react-native';

import type { Book, Progress } from '@/api/types';

jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
// The row's "..." menu has its own tests (it reads the download and queue stores).
jest.mock('./book-actions', () => ({ BookActionsButton: () => null }));
// The progress column reads the player; these rows have no progress.
jest.mock('@/components/player/use-time-left', () => ({ useBookTimeLeft: () => undefined }));

/* eslint-disable import/first */
import { BookListRow } from './book-items';
/* eslint-enable import/first */

const omnibus: Book = {
  id: 1,
  library_id: 1,
  rel_path: 'Sanderson/Mistborn/The Final Empire Trilogy',
  is_folder: true,
  title: 'The Mistborn Trilogy',
  author: 'Brandon Sanderson',
  series: 'Mistborn',
  series_index: 1,
  narrator: 'Michael Kramer',
  duration: 3600,
  format: 'm4b',
  size: 1,
};

describe('BookListRow', () => {
  it('numbers a book in its series, a range as "#1-3"', async () => {
    await render(
      <BookListRow
        connectionId="c"
        libraryId={1}
        book={{ ...omnibus, series_index_end: 3 }}
        columns="some"
      />,
    );
    expect(screen.getByText('Brandon Sanderson · Mistborn #1-3')).toBeTruthy();
  });

  it('numbers a single position as before (an older server sends no end)', async () => {
    await render(<BookListRow connectionId="c" libraryId={1} book={omnibus} columns="some" />);
    expect(screen.getByText('Brandon Sanderson · Mistborn #1')).toBeTruthy();
  });

  // fe#313: the phone line and the progress column read a saved place by one rule
  // (`savedProgressView`: the row's own length, else the book's), so a row never says two
  // percents between layouts.
  it('says the same percent in the phone line and the progress column', async () => {
    const progress = {
      library_id: 1,
      path: omnibus.rel_path,
      position: 1800,
      duration: 7200,
      finished: false,
      updated_at: '2026-10-01T00:00:00Z',
    } as Progress;
    await render(
      <BookListRow
        connectionId="c"
        libraryId={1}
        book={omnibus}
        progress={progress}
        columns="none"
      />,
    );
    expect(screen.getByText('Brandon Sanderson · Mistborn #1 · 1h · 25% listened')).toBeTruthy();
    await render(
      <BookListRow
        connectionId="c"
        libraryId={1}
        book={omnibus}
        progress={progress}
        columns="some"
      />,
    );
    expect(screen.getByText('25%')).toBeTruthy();
  });
});
