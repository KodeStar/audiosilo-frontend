import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

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
jest.mock('@/api/hooks', () => ({
  useBook: () => mockBook,
  useCapability: () => true,
  useReadingPlace: () => mockPlace,
}));
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

/** A save of this book is answered with `kept` as the server's row. */
const answered = (kept: ReadingProgress) =>
  act(async () => {
    mockHeard!({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
      saved: { reading_progress: kept },
    });
  });

describe('ReaderScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHost = null;
    mockShortcuts.length = 0;
    mockBook = query({ title: 'Alice', ebook: { path: 'A/Book/alice.epub', size: 1 } });
    mockPlace = query({ place: null, fromServer: null });
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

  it('offers nothing for this device’s own place', async () => {
    await mount();
    await opened();
    await answered(row({ device_id: 'dev' }));
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
    expect(screen.getByText('Try again')).toBeTruthy();
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
