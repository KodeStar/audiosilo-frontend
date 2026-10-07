import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { BookMetaRecap, Progress } from '@/api/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'phone',
}));
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: unknown }) => children,
}));
jest.mock('@/playback/store', () => ({
  usePlayer: (sel: (s: object) => unknown) => sel({ nowPlaying: null }),
}));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
const mockClient = { name: 'the book’s own client' };
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (id: string) => (id === 'c' ? mockClient : null),
}));
const mockLookup = jest.fn();
jest.mock('@/playback/progress-sync', () => ({
  loadInitialProgress: (...a: unknown[]) => mockLookup(...a),
}));
const mockStart = jest.fn();
jest.mock('@/components/player/start-book', () => ({
  startBookInPlace: (...a: unknown[]) => mockStart(...a),
}));

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
// Ten chapters of 360 s; Home's row has the listener in chapter 10, past "up to 8".
const mockStarts = Array.from({ length: 10 }, (_, i) => i * 360);
const mockRecaps: BookMetaRecap[] = [
  { through: { chapter: 8 }, scope: 'book', text: 'Up to 8: the shroud is stolen.' },
];
jest.mock('@/components/library/use-book-community', () => ({
  useBookCommunity: () => ({
    metadata: true,
    book: { title: 'Mistborn', author: 'Brandon Sanderson' },
    enabled: true,
    chapterData: {
      chapters: mockStarts.map((s, i) => ({ title: `Part ${i + 1}`, book_offset: s })),
      files: [],
    },
    chapterStarts: mockStarts,
    work: { recaps: mockRecaps },
    loading: false,
  }),
}));

/* eslint-disable import/first */
import { PreviouslyOnCard, resumeWithOverlap } from './previously-on';
/* eslint-enable import/first */

const at = { connectionId: 'c', libraryId: 1, path: 'Sanderson/Mistborn' };
/** Home's copy of the server's row: 14 days old. */
const saved = {
  connectionId: 'c',
  connectionName: 'Home',
  library_id: 1,
  path: at.path,
  position: 3570,
  duration: 3600,
  finished: false,
  playback_speed: 1.25,
  version: 0,
  device_id: 'other-device',
  updated_at: ago(14),
};
/** A place the resume lookup found (the server, the local mirror or the offline queue). */
const found = (over: Partial<Progress>) => ({
  kind: 'progress',
  progress: { ...saved, device_id: 'this-device', ...over },
});

beforeEach(() => {
  mockLookup.mockReset();
  mockStart.mockReset().mockResolvedValue(true);
  mockPush.mockReset();
});

describe('resumeWithOverlap', () => {
  it('starts 30 s before a newer place this device holds, at its speed', async () => {
    // Listened offline since: the newer place waits in the offline queue.
    mockLookup.mockResolvedValue(
      found({ position: 5000, playback_speed: 1.5, updated_at: ago(13) }),
    );
    await expect(resumeWithOverlap(at, saved)).resolves.toBe(true);
    expect(mockLookup).toHaveBeenCalledWith(mockClient, 'c', 1, at.path);
    expect(mockStart).toHaveBeenCalledWith(at, { position: 4970, speed: 1.5 });
  });

  it('starts from the row Home has when the lookup fails, finds nothing or finds it finished', async () => {
    for (const lookup of [
      { kind: 'failed' },
      { kind: 'empty' },
      found({ position: 3600, finished: true, updated_at: ago(1) }),
    ]) {
      mockStart.mockClear();
      mockLookup.mockResolvedValue(lookup);
      await resumeWithOverlap(at, saved);
      expect(mockStart).toHaveBeenCalledWith(at, { position: 3540, speed: 1.25 });
    }
  });

  it('keeps the row Home has over an older local record (the server unreachable)', async () => {
    mockLookup.mockResolvedValue(found({ position: 1000, updated_at: ago(30) }));
    await resumeWithOverlap(at, saved);
    expect(mockStart).toHaveBeenCalledWith(at, { position: 3540, speed: 1.25 });
  });
});

describe('PreviouslyOnCard', () => {
  // The card shows Home's row (chapter 10); Resume must still start from the newer place.
  it('resumes from the newest place, then opens the player over the book page on a phone', async () => {
    mockLookup.mockResolvedValue(
      found({ position: 5000, playback_speed: 1.5, updated_at: ago(13) }),
    );
    await render(<PreviouslyOnCard at={at} saved={saved} />);
    expect(screen.getByText('You left Mistborn in Part 10.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Resume, with 30 seconds of overlap'));
    await waitFor(() =>
      expect(mockPush.mock.calls.map((c) => c[0].pathname)).toEqual([
        '/book/[libraryId]',
        '/player',
      ]),
    );
    expect(mockStart).toHaveBeenCalledWith(at, { position: 4970, speed: 1.5 });
  });
});
