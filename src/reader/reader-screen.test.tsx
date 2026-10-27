import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import type { ReadingProgress } from '@/api/types';
import { backOrHome } from '@/lib/back-or-home';
import type { ShortcutKey } from '@/lib/keyboard';
import { mountWithPortal } from '@/testing/render-overlay';

import {
  type ReaderHostEvent,
  type ReaderHostHandle,
  type ReaderHostProps,
  ReaderStartError,
} from './reader-host-types';
import { adoptServerPlace, type ReadingSaved } from './reading-progress';

type Query = { data?: unknown; isError: boolean; error: unknown; refetch: jest.Mock };
let mockBook: Query;
let mockPlace: Query;
let mockEbooks: boolean | undefined = true;
/** The last `useReadingPlace` call: (libraryId, path, connectionId, enabled, hasLocalCopy). */
let mockPlaceArgs: unknown[] = [];
jest.mock('@/api/hooks', () => ({
  useBook: () => mockBook,
  useCapability: () => mockEbooks,
  useReadingPlace: (...args: unknown[]) => {
    mockPlaceArgs = args;
    return mockPlace;
  },
}));
// The book's download entry, and whether its EPUB is on the device (ebook-file's tests).
let mockDownload: { status: string; manifest: { ebookUri?: string } } | undefined;
jest.mock('@/downloads/store', () => ({
  useDownloadedEbook: () =>
    (mockDownload?.status === 'downloaded' && mockDownload.manifest.ebookUri) || undefined,
}));
const mockHasLocalEbook = jest.fn(async (_ref: unknown) => true);
jest.mock('./ebook-file', () => ({ hasLocalEbook: (ref: unknown) => mockHasLocalEbook(ref) }));
jest.mock('@/api/provider', () => ({ useOptionalApi: () => ({}) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/lib/back-or-home', () => ({ backOrHome: jest.fn() }));
jest.mock('@/playback/progress-sync', () => ({ getDeviceId: () => Promise.resolve('dev') }));

// The screen's keyboard shortcuts as it registers them (jest runs the native platform, where
// they never listen): what each matches, and what it does.
type Shortcut = { matches: (e: ShortcutKey, editable: boolean) => boolean; run: () => void };
const mockShortcuts: Shortcut[] = [];
jest.mock('@/lib/keyboard', () => ({
  useGlobalShortcut: (_enabled: boolean, matches: Shortcut['matches'], run: () => void) => {
    mockShortcuts.push({ matches, run });
  },
}));
/** The latest registered shortcut a key press matches, if any. */
const shortcutFor = (key: string, mods: Partial<ShortcutKey> = {}) =>
  mockShortcuts.findLast((s) =>
    s.matches({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods }, false),
  );

// The host is the platform's part (its own tests): here it hands the screen the reader's
// messages and takes its page turns.
const mockHandle: ReaderHostHandle = { goto: jest.fn(), next: jest.fn(), prev: jest.fn() };
let mockHost: ReaderHostProps | null = null;
jest.mock('./reader-host', () => ({
  ReaderHost: (props: ReaderHostProps) => {
    mockHost = props;
    jest
      .requireActual<typeof import('react')>('react')
      .useImperativeHandle(props.ref, () => mockHandle);
    return null;
  },
}));

let mockHeard: ((saved: ReadingSaved) => void) | null = null;
jest.mock('./reading-progress', () => ({
  ...jest.requireActual('./reading-progress'),
  adoptServerPlace: jest.fn(() => Promise.resolve()),
  captureReadingSave: jest.fn(() => new Promise(() => {})),
  saveReadingPlace: jest.fn(),
  flushReadingQueue: jest.fn(() => Promise.resolve()),
  onReadingSaved: (listener: (saved: ReadingSaved) => void) => {
    mockHeard = listener;
    return () => {
      mockHeard = null;
    };
  },
}));

/* eslint-disable import/first */
import { ReaderScreen } from './reader-screen';
/* eslint-enable import/first */

const CFI_A = 'epubcfi(/6/4!/4/2/1:0)';
const CFI_B = 'epubcfi(/6/12!/4/2/1:0)';

const query = (data: unknown, error: unknown = null): Query => ({
  data,
  isError: error !== null,
  error,
  refetch: jest.fn(),
});

function row(p: Partial<ReadingProgress> = {}): ReadingProgress {
  return {
    library_id: 1,
    path: 'A/Book',
    cfi: CFI_B,
    progression: 0.6,
    version: 9,
    device_id: 'phone',
    device_name: 'Pixel 8',
    updated_at: '2026-10-01T10:00:00.000Z',
    ...p,
  };
}

async function mount() {
  await mountWithPortal(<ReaderScreen connectionId="c1" libraryId={1} path="A/Book" />);
}

/** The reader says something to the screen. */
const say = (message: ReaderHostEvent) =>
  act(async () => {
    mockHost!.onMessage(message);
  });

/** The book shows, at `cfi`. */
async function opened(cfi = CFI_A, { rtl = false } = {}) {
  await waitFor(() => expect(mockHost).not.toBeNull());
  await say({ type: 'opened', title: 'Alice', toc: [], rtl });
  await say({ type: 'progress', cfi, fraction: 0.2, sectionLabel: '' });
}

/** The host made the reader document again (the app's WebView died, the web's frame
 * reloaded). */
const reopened = () =>
  act(async () => {
    mockHost!.onReopen!();
  });

/** The page edges on screen. */
const edges = () => screen.queryAllByLabelText(/^(Next|Previous) page$/);

/** A save of this book is answered with `kept` as the server's row; `seen`: this device
 * had seen it (its own save, or its own row at a version it acknowledged). */
const answered = (kept: ReadingProgress, seen = false) =>
  act(async () => {
    mockHeard!({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
      saved: { reading_progress: kept },
      seen,
    });
  });

describe('ReaderScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHost = null;
    mockShortcuts.length = 0;
    mockBook = query({ title: 'Alice', ebook: { path: 'A/Book/alice.epub', size: 1 } });
    mockPlace = query({ place: null, fromServer: null });
    mockEbooks = true;
    mockDownload = undefined;
  });

  it('reads a download holding the EPUB offline, the capability unknown', async () => {
    mockEbooks = undefined;
    mockDownload = { status: 'downloaded', manifest: { ebookUri: 'file:///d/book.epub' } };
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    expect(mockPlaceArgs[3]).toBe(true);
    // The offline lookup asks whether the EPUB is here: the download's copy, or the cache
    // file at the ebook's size.
    const hasLocalCopy = mockPlaceArgs[4] as () => Promise<boolean>;
    await expect(hasLocalCopy()).resolves.toBe(true);
    expect(mockHasLocalEbook).toHaveBeenCalledWith({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
      size: 1,
      saved: 'file:///d/book.epub',
    });
  });

  it('waits, never looking up a place, with the capability unknown and no downloaded EPUB', async () => {
    mockEbooks = undefined;
    mockDownload = { status: 'downloaded', manifest: {} };
    await mount();
    expect(mockPlaceArgs[3]).toBe(false);
    expect(mockHost).toBeNull();
  });

  it('hands the host the book’s connection and its ebook’s size (the app’s cache rule)', async () => {
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    expect(mockHost).toMatchObject({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
      ebookSize: 1,
    });
  });

  it('offers another device’s further place, and Stay acknowledges it', async () => {
    await mount();
    await opened();
    await answered(row());
    expect(screen.getByText('On Pixel 8 you were at 60%. Jump there?')).toBeTruthy();
    expect(adoptServerPlace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Stay'));
    expect(adoptServerPlace).toHaveBeenCalledWith('c1', 1, 'A/Book', row());
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
  });

  it('jumps there, and acknowledges it', async () => {
    await mount();
    await opened();
    await answered(row());
    await fireEvent.press(screen.getByText('Jump'));
    expect(mockHandle.goto).toHaveBeenCalledWith({ cfi: CFI_B });
    expect(adoptServerPlace).toHaveBeenCalledWith('c1', 1, 'A/Book', row());
  });

  it('judges an answer heard before the first page against that page', async () => {
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    await answered(row());
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
    await opened(CFI_A);
    expect(screen.getByTestId('reader-jump-offer')).toBeTruthy();
  });

  it('offers nothing when the book opens where an answer heard first kept it', async () => {
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    await answered(row());
    await opened(CFI_B);
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
    expect(adoptServerPlace).toHaveBeenCalledWith('c1', 1, 'A/Book', row());
  });

  it('acknowledges another device’s place the reader is already at, offering nothing', async () => {
    await mount();
    await opened(CFI_B);
    await answered(row());
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
    expect(adoptServerPlace).toHaveBeenCalledWith('c1', 1, 'A/Book', row());
  });

  it('offers nothing for a place this device had seen (its own save)', async () => {
    await mount();
    await opened();
    await answered(row({ device_id: 'dev' }), true);
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
    expect(adoptServerPlace).not.toHaveBeenCalled();
  });

  it('says so when where the book opens could not be found out, and looks again', async () => {
    mockPlace = query(undefined, new TypeError('offline'));
    await mount();
    expect(await screen.findByText("Couldn't load the ebook")).toBeTruthy();
    expect(mockHost).toBeNull();
    await fireEvent.press(screen.getByText('Try again'));
    expect(mockPlace.refetch).toHaveBeenCalled();
  });

  it('says the book is gone when the server has no ebook for it', async () => {
    mockBook = query(undefined, new ApiError(404, 'not found'));
    await mount();
    expect(await screen.findByText("The ebook isn't on the server any more")).toBeTruthy();
  });

  it('says the reader did not start, with Try again', async () => {
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    await act(async () => mockHost!.onLoadError(new ReaderStartError()));
    expect(screen.getByText("The reader didn't start")).toBeTruthy();
    // The app's reader is a WebView that stopped: no browser or proxy to blame.
    expect(screen.getByText(/^The ebook reader stopped\./)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('names the browser when the web reader did not start', async () => {
    const prevOS = Platform.OS;
    try {
      Platform.OS = 'web';
      await mount();
      await waitFor(() => expect(mockHost).not.toBeNull());
      await act(async () => mockHost!.onLoadError(new ReaderStartError()));
      expect(screen.getByText(/^The ebook reader didn't run in this browser\./)).toBeTruthy();
      expect(screen.queryByText(/^The ebook reader stopped\./)).toBeNull();
    } finally {
      Platform.OS = prevOS;
    }
  });

  it('says a book that never opened cannot be opened, with no Try again', async () => {
    await mount();
    await waitFor(() => expect(mockHost).not.toBeNull());
    await say({ type: 'error', code: 'unreadable', message: 'not a zip' });
    expect(screen.getByText("This ebook can't be opened")).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('hides the page edges, the toolbar and the offer while the reader is made again', async () => {
    await mount();
    await opened();
    await answered(row());
    expect(edges()).toHaveLength(2);
    expect(screen.getByLabelText('Contents')).toBeTruthy();
    expect(screen.getByTestId('reader-jump-offer')).toBeTruthy();
    await reopened();
    expect(edges()).toHaveLength(0);
    expect(screen.queryByLabelText('Contents')).toBeNull();
    expect(screen.queryByTestId('reader-jump-offer')).toBeNull();
    // Its next `opened`: the book shows again, and the offer with it.
    await say({ type: 'opened', title: 'Alice', toc: [], rtl: false });
    expect(edges()).toHaveLength(2);
    expect(screen.getByTestId('reader-jump-offer')).toBeTruthy();
  });

  it('says a reopen that fails as a reader that stopped, with Try again', async () => {
    await mount();
    await opened();
    await reopened();
    // The memory pressure that took the last WebView fails the new one's open.
    await say({ type: 'error', code: 'unreadable', message: 'RangeError: allocation failed' });
    expect(screen.getByText("The reader didn't start")).toBeTruthy();
    expect(screen.queryByText("This ebook can't be opened")).toBeNull();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('shows no page edges after Try again until the book shows again', async () => {
    await mount();
    await opened();
    // The app's host gave up while the book showed (its last WebView died after `opened`).
    await act(async () => mockHost!.onLoadError(new ReaderStartError()));
    await fireEvent.press(screen.getByText('Try again'));
    // A new host, and nothing over it until its book shows.
    expect(screen.queryByText("The reader didn't start")).toBeNull();
    expect(edges()).toHaveLength(0);
    await say({ type: 'opened', title: 'Alice', toc: [], rtl: false });
    expect(edges()).toHaveLength(2);
  });

  it('opens again where the reader was on Try again, not where the screen first opened', async () => {
    mockPlace = query({
      place: { cfi: CFI_A, progression: 0.2, device_id: 'dev', updated_at: '2026-10-01' },
      fromServer: null,
    });
    await mount();
    await waitFor(() => expect(mockHost?.at).toEqual({ cfi: CFI_A, fraction: 0.2 }));
    await opened(CFI_A);
    await say({ type: 'progress', cfi: CFI_B, fraction: 0.6, sectionLabel: 'II' });
    await act(async () => mockHost!.onLoadError(new ReaderStartError()));
    await fireEvent.press(screen.getByText('Try again'));
    // The new host (the next attempt) opens at the last page shown.
    await waitFor(() => expect(mockHost?.at).toEqual({ cfi: CFI_B, fraction: 0.6 }));
  });

  it('turns a right-to-left book forward from the left edge', async () => {
    await mount();
    await opened(CFI_A, { rtl: true });
    // The edges in order: left, then right.
    const [left, right] = screen.getAllByLabelText(/^(Next|Previous) page$/);
    expect([left.props.accessibilityLabel, right.props.accessibilityLabel]).toEqual([
      'Next page',
      'Previous page',
    ]);
    await fireEvent.press(left);
    expect(mockHandle.next).toHaveBeenCalled();
    expect(mockHandle.prev).not.toHaveBeenCalled();
    jest.clearAllMocks();
    shortcutFor('ArrowLeft')!.run();
    expect(mockHandle.next).toHaveBeenCalled();
    expect(mockHandle.prev).not.toHaveBeenCalled();
  });

  it('leaves an arrow with Cmd, Ctrl or Alt to the browser (Back)', async () => {
    await mount();
    await opened();
    expect(shortcutFor('ArrowLeft')).toBeDefined();
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(shortcutFor('ArrowLeft', { [mod]: true })).toBeUndefined();
      expect(shortcutFor('ArrowRight', { [mod]: true })).toBeUndefined();
    }
  });

  it('closes on Escape pressed in the book', async () => {
    await mount();
    await opened();
    await say({ type: 'escape' });
    expect(backOrHome).toHaveBeenCalled();
  });
});
