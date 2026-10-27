import { act, render, screen } from '@testing-library/react-native';

import type { Book } from '@/api/types';
import i18n from '@/i18n';

// The tile itself (cover, progress, menu) has its own tests: this one reads its caption.
jest.mock('../cover-tile', () => ({
  CoverTile: ({ caption }: { caption?: string }) => {
    const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
    return <T testID="caption">{caption}</T>;
  },
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/player/use-time-left', () => ({ useBookTimeLeft: () => undefined }));
jest.mock('./book-actions', () => ({ BookActionsButton: () => null }));

/* eslint-disable import/first */
import { BookTile } from './book-items';
/* eslint-enable import/first */

const NOW = Date.parse('2026-10-27T12:00:00Z');

const book: Book = {
  id: 1,
  library_id: 1,
  rel_path: 'Author/Book',
  is_folder: true,
  title: 'Book',
  author: 'Author',
  series: '',
  series_index: 0,
  narrator: '',
  duration: 3600,
  format: 'm4b',
  size: 1,
  added_at: new Date(NOW - 5 * 60_000).toISOString(),
};

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(async () => {
  jest.useRealTimers();
  await i18n.changeLanguage('en');
});

// fe#162: the grid's "added" caption kept the language and minute of its first render.
describe('BookTile caption (Recently added)', () => {
  it('follows a language switch', async () => {
    await render(<BookTile connectionId="c" libraryId={1} book={book} sort="recent" width={120} />);
    expect(screen.getByTestId('caption')).toHaveTextContent('Author · 5 minutes ago');
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(screen.getByTestId('caption')).toHaveTextContent('Author · vor 5 Minuten');
  });

  it('moves on with the clock rather than freezing', async () => {
    await render(<BookTile connectionId="c" libraryId={1} book={book} sort="recent" width={120} />);
    expect(screen.getByTestId('caption')).toHaveTextContent('Author · 5 minutes ago');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByTestId('caption')).toHaveTextContent('Author · 8 minutes ago');
  });

  it('reads the minute afresh when the order turns to Recently added', async () => {
    const tile = (sort: 'title' | 'recent') => (
      <BookTile connectionId="c" libraryId={1} book={book} sort={sort} width={120} />
    );
    const { rerender } = await render(tile('title'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10 * 60_000);
    });
    await rerender(tile('recent'));
    expect(screen.getByTestId('caption')).toHaveTextContent('Author · 15 minutes ago');
  });

  it('says only the author in another order', async () => {
    await render(<BookTile connectionId="c" libraryId={1} book={book} sort="title" width={120} />);
    expect(screen.getByTestId('caption')).toHaveTextContent('Author');
  });
});
