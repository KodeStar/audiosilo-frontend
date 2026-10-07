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
  focusOwnsKeys: false,
  loaded: true,
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

  it('leaves Space and the arrows to a focused control (a button, a slider)', () => {
    const focused = { ...CTX, focusOwnsKeys: true };
    expect(playerShortcutFor(key(' '), focused)).toBeNull();
    expect(playerShortcutFor(key('ArrowLeft'), focused)).toBeNull();
    expect(playerShortcutFor(key('ArrowRight', { shiftKey: true }), focused)).toBeNull();
    // Letters still work there.
    expect(playerShortcutFor(key('k'), focused)).toBe('toggle');
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
