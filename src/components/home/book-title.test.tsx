import { render } from '@testing-library/react-native';

import type { SourcedProgress } from '@/api/hooks';
import type { Book } from '@/api/types';

let mockBook: Partial<Book> | undefined;
jest.mock('@/api/hooks', () => ({ useKnownBook: () => mockBook }));
jest.mock('@/components/player/use-time-left', () => ({ useBookTimeLeft: () => undefined }));
const mockCoverTile = jest.fn((_props: { coverVersion?: string }) => null);
jest.mock('@/components/library/cover-tile', () => ({
  CoverTile: (p: { coverVersion?: string }) => mockCoverTile(p),
}));

/* eslint-disable import/first */
import { ProgressTile } from './book-title';
/* eslint-enable import/first */

const item = (over: Partial<SourcedProgress> = {}): SourcedProgress => ({
  connectionId: 'c1',
  connectionName: 'Home',
  library_id: 1,
  path: 'A/Book',
  position: 30,
  duration: 100,
  finished: false,
  playback_speed: 1,
  version: 1,
  device_id: 'd',
  updated_at: '2026-11-01T00:00:00Z',
  ...over,
});

const handed = () => mockCoverTile.mock.calls.at(-1)?.[0].coverVersion;

beforeEach(() => {
  mockBook = undefined;
  mockCoverTile.mockClear();
});

describe('ProgressTile cover version', () => {
  it("takes the progress row's own cover_version, before its book has loaded", async () => {
    await render(<ProgressTile item={item({ cover_version: 'row1' })} width={120} />);
    expect(handed()).toBe('row1');
  });

  it("keeps the row's version over its book's, so the URL doesn't change as the book loads", async () => {
    mockBook = { title: 'Book', cover_version: 'book1' };
    await render(<ProgressTile item={item({ cover_version: 'row1' })} width={120} />);
    expect(handed()).toBe('row1');
  });

  it("falls back to the book's version for a row from an older server", async () => {
    mockBook = { title: 'Book', cover_version: 'book1' };
    await render(<ProgressTile item={item()} width={120} />);
    expect(handed()).toBe('book1');
    mockBook = undefined;
    await render(<ProgressTile item={item()} width={120} />);
    expect(handed()).toBeUndefined();
  });
});
