import type { PlayerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/api/provider', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
jest.mock('@/api/connection-clients', () => ({ resolveClient: jest.fn() }));

/* eslint-disable import/first */
import { resolveClient } from '@/api/connection-clients';
import { queryClient } from '@/api/provider';
import { toast } from '@/components/ui/toast';
import i18n from '@/i18n';
import { ownsArrows, ownsSpace } from '@/lib/keyboard';
import { useSettings } from '@/stores/settings';
import { playerStoreMock } from '@/testing/player-store-mock';

import { usePlayerSheets } from './player-sheets';
import {
  addBookmarkHere,
  type PlayerKey,
  type PlayerKeyContext,
  playerShortcutFor,
  runPlayerShortcut,
} from './player-shortcuts';
/* eslint-enable import/first */

const t = i18n.t.bind(i18n);

const key = (k: string, mods: Partial<PlayerKey> = {}): PlayerKey => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const CTX: PlayerKeyContext = {
  editable: false,
  modalOpen: false,
  focusOwnsSpace: false,
  focusOwnsArrows: false,
  loaded: true,
};

/** The context the web listener (`use-player-shortcuts.ts`) builds with this focused. */
const focusedOn = (tagName: string, role: string | null = null): PlayerKeyContext => {
  const el = {
    tagName,
    getAttribute: (n: string) => (n === 'role' ? role : null),
  } as unknown as Element;
  return { ...CTX, focusOwnsSpace: ownsSpace(el), focusOwnsArrows: ownsArrows(el) };
};

describe('playerShortcutFor', () => {
  it.each([
    [' ', 'toggle'],
    ['k', 'toggle'],
    ['K', 'toggle'],
    ['j', 'back'],
    ['ArrowLeft', 'back'],
    ['l', 'forward'],
    ['ArrowRight', 'forward'],
    ['[', 'slower'],
    [']', 'faster'],
    ['b', 'bookmark'],
    ['B', 'bookmark'],
    ['p', 'openPlayer'],
    ['z', 'sleep'],
    ['?', 'help'],
    ['Escape', 'close'],
  ])('maps %p to %s', (k, action) => {
    expect(playerShortcutFor(key(k), CTX)).toBe(action);
  });

  it('maps Shift+arrows to previous and next chapter', () => {
    expect(playerShortcutFor(key('ArrowLeft', { shiftKey: true }), CTX)).toBe('previousChapter');
    expect(playerShortcutFor(key('ArrowRight', { shiftKey: true }), CTX)).toBe('nextChapter');
  });

  it('leaves Q (Up next) and the palette keys to their own handlers', () => {
    expect(playerShortcutFor(key('q'), CTX)).toBeNull();
    expect(playerShortcutFor(key('/'), CTX)).toBeNull();
    expect(playerShortcutFor(key('k', { metaKey: true }), CTX)).toBeNull();
  });

  it('never fires while typing or over another dialog', () => {
    for (const k of [' ', 'k', 'ArrowLeft', '?', 'Escape', 'b']) {
      expect(playerShortcutFor(key(k), { ...CTX, editable: true })).toBeNull();
      expect(playerShortcutFor(key(k), { ...CTX, modalOpen: true })).toBeNull();
    }
  });

  it('ignores modified keys (browser and OS shortcuts)', () => {
    expect(playerShortcutFor(key('l', { ctrlKey: true }), CTX)).toBeNull();
    expect(playerShortcutFor(key('b', { altKey: true }), CTX)).toBeNull();
    expect(playerShortcutFor(key('ArrowLeft', { metaKey: true }), CTX)).toBeNull();
  });

  it('needs a loaded book, except for ? and Esc', () => {
    const idle = { ...CTX, loaded: false };
    expect(playerShortcutFor(key(' '), idle)).toBeNull();
    expect(playerShortcutFor(key('b'), idle)).toBeNull();
    expect(playerShortcutFor(key('?'), idle)).toBe('help');
    expect(playerShortcutFor(key('Escape'), idle)).toBe('close');
  });

  it('leaves Space and the arrows each to a focused control that uses that key', () => {
    const space = { ...CTX, focusOwnsSpace: true };
    expect(playerShortcutFor(key(' '), space)).toBeNull();
    expect(playerShortcutFor(key('ArrowLeft'), space)).toBe('back');
    const arrows = { ...CTX, focusOwnsArrows: true };
    expect(playerShortcutFor(key('ArrowLeft'), arrows)).toBeNull();
    expect(playerShortcutFor(key('ArrowRight', { shiftKey: true }), arrows)).toBeNull();
    expect(playerShortcutFor(key(' '), arrows)).toBe('toggle');
  });

  it('plays and pauses with Space over a focused slider, which keeps the arrows', () => {
    // Space used to stand aside here, and gesture-handler turned it into a tap at the
    // slider's centre: the timeline jumped to the middle of the book.
    const slider = focusedOn('DIV', 'slider');
    expect(playerShortcutFor(key(' '), slider)).toBe('toggle');
    expect(playerShortcutFor(key('ArrowLeft'), slider)).toBeNull();
    expect(playerShortcutFor(key('ArrowRight', { shiftKey: true }), slider)).toBeNull();
  });

  it('skips with the arrows over a focused button, which keeps Space', () => {
    // After a click on the dock's play button the focus stays on it.
    for (const button of [focusedOn('BUTTON'), focusedOn('DIV', 'button')]) {
      expect(playerShortcutFor(key('ArrowRight'), button)).toBe('forward');
      expect(playerShortcutFor(key('ArrowLeft', { shiftKey: true }), button)).toBe(
        'previousChapter',
      );
      expect(playerShortcutFor(key(' '), button)).toBeNull();
    }
  });

  it('leaves both to a focused tab, and the letters work over any control', () => {
    const tab = focusedOn('DIV', 'tab');
    expect(playerShortcutFor(key(' '), tab)).toBeNull();
    expect(playerShortcutFor(key('ArrowRight'), tab)).toBeNull();
    expect(playerShortcutFor(key('k'), tab)).toBe('toggle');
    expect(playerShortcutFor(key('l'), focusedOn('DIV', 'slider'))).toBe('forward');
  });

  it('ignores other keys', () => {
    expect(playerShortcutFor(key('x'), CTX)).toBeNull();
    expect(playerShortcutFor(key('Enter'), CTX)).toBeNull();
  });
});

describe('runPlayerShortcut', () => {
  let player: PlayerStoreMock;
  const env = {
    t,
    onPlayer: false,
    openPlayer: jest.fn(),
    closePlayer: jest.fn(),
  };
  const spies = {
    retry: jest.fn(),
    skipSeconds: jest.fn(),
    seekBook: jest.fn(),
    setRate: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    player = playerStoreMock();
    player.reset();
    player.clearSpies();
    player.usePlayer.setState({
      ...spies,
      rate: 1.25,
      bookPosition: 700,
      nowPlaying: {
        connectionId: 'srv',
        libraryId: 1,
        path: 'a/book',
        queue: { chapters: [], total: 3600, offsets: [0] } as never,
      },
      snapshot: { state: 'playing', trackIndex: 0, position: 700, duration: 3600, rate: 1 },
    } as never);
    useSettings.setState({ skipForward: 30, skipBackward: 15 });
    usePlayerSheets.setState({ open: null });
  });

  it('plays and pauses, or retries a failed book', () => {
    expect(runPlayerShortcut('toggle', env)).toBe(true);
    expect(player.spies.toggle).toHaveBeenCalled();
    player.setPlayState('error');
    runPlayerShortcut('toggle', env);
    expect(spies.retry).toHaveBeenCalled();
  });

  it('skips by the skip lengths', () => {
    runPlayerShortcut('back', env);
    expect(spies.skipSeconds).toHaveBeenLastCalledWith(-15);
    runPlayerShortcut('forward', env);
    expect(spies.skipSeconds).toHaveBeenLastCalledWith(30);
  });

  it('changes speed by 0.05', () => {
    runPlayerShortcut('faster', env);
    expect(spies.setRate).toHaveBeenLastCalledWith(1.3);
    runPlayerShortcut('slower', env);
    expect(spies.setRate).toHaveBeenLastCalledWith(1.2);
  });

  it('opens the full player, but not over itself', () => {
    expect(runPlayerShortcut('openPlayer', env)).toBe(true);
    expect(env.openPlayer).toHaveBeenCalled();
    expect(runPlayerShortcut('openPlayer', { ...env, onPlayer: true })).toBe(false);
  });

  it('asks for the sleep sheet and the shortcuts overlay', () => {
    runPlayerShortcut('sleep', env);
    expect(usePlayerSheets.getState().open).toBe('sleep');
    runPlayerShortcut('help', env);
    expect(usePlayerSheets.getState().open).toBe('shortcuts');
  });

  it('closes the top layer: a sheet, else the full player, else nothing', () => {
    usePlayerSheets.setState({ open: 'sleep' });
    expect(runPlayerShortcut('close', { ...env, onPlayer: true })).toBe(true);
    expect(usePlayerSheets.getState().open).toBeNull();
    expect(env.closePlayer).not.toHaveBeenCalled();
    expect(runPlayerShortcut('close', { ...env, onPlayer: true })).toBe(true);
    expect(env.closePlayer).toHaveBeenCalled();
    expect(runPlayerShortcut('close', env)).toBe(false);
  });
});

describe('addBookmarkHere', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const player = playerStoreMock();
    player.reset();
    player.usePlayer.setState({
      bookPosition: 62_810.4,
      nowPlaying: {
        connectionId: 'srv',
        libraryId: 1,
        path: 'a/book',
        queue: { chapters: [], total: 99_999 },
      },
    });
  });

  it("adds a bookmark at the place on the playing book's server, and says so", async () => {
    const addBookmark = jest.fn(() => Promise.resolve({}));
    (resolveClient as jest.Mock).mockReturnValue({ addBookmark });
    await addBookmarkHere(t);
    expect(resolveClient).toHaveBeenCalledWith('srv');
    expect(addBookmark).toHaveBeenCalledWith(1, 'a/book', 62_810, '');
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['bookmarks', 'srv', 1, 'a/book'],
    });
    expect(toast).toHaveBeenCalledWith({ title: 'Bookmark added', description: '17:26:50' });
  });

  it('adds one bookmark for a double tap while the first is on its way', async () => {
    let land: (v: object) => void = () => {};
    const addBookmark = jest
      .fn(() => Promise.resolve({}))
      .mockImplementationOnce(() => new Promise<object>((r) => (land = r)));
    (resolveClient as jest.Mock).mockReturnValue({ addBookmark });
    const first = addBookmarkHere(t);
    const second = addBookmarkHere(t);
    land({});
    await Promise.all([first, second]);
    expect(addBookmark).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    // Once it has landed, the next tap adds another.
    await addBookmarkHere(t);
    expect(addBookmark).toHaveBeenCalledTimes(2);
  });

  it('says when it could not', async () => {
    (resolveClient as jest.Mock).mockReturnValue({
      addBookmark: () => Promise.reject(new Error('offline')),
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await addBookmarkHere(t);
    expect(toast).toHaveBeenCalledWith({ title: "Couldn't add the bookmark" });
    (resolveClient as jest.Mock).mockReturnValue(null);
    await addBookmarkHere(t);
    expect(toast).toHaveBeenCalledTimes(2);
  });
});
