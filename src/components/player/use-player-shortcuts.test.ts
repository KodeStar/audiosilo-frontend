/**
 * @jest-environment jsdom
 */

// The web listener end to end, on a real DOM: the focused element and the open layers it
// reads, through the key map, to the action it runs (a spy here; the actions themselves
// are `player-shortcuts.test.ts`).
import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useSegments: () => [],
}));
const mockRun = jest.fn((_action: string, _env: unknown) => true);
jest.mock('./player-shortcuts', () => ({
  ...jest.requireActual('./player-shortcuts'),
  runPlayerShortcut: (action: string, env: unknown) => mockRun(action, env),
}));

/* eslint-disable import/first */
import { playerStoreMock } from '@/testing/player-store-mock';

import { usePlayerShortcuts } from './use-player-shortcuts';
/* eslint-enable import/first */

/** Press `key` with the focus on a new `<tag role=...>` (or on nothing). */
function press(key: string, focus?: { tag: string; role?: string }): KeyboardEvent {
  let target: HTMLElement = document.body;
  if (focus) {
    target = document.createElement(focus.tag);
    if (focus.role) target.setAttribute('role', focus.role);
    target.tabIndex = 0;
    document.body.appendChild(target);
    target.focus();
  }
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe('usePlayerShortcuts', () => {
  const prevOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
    mockRun.mockClear();
    const player = playerStoreMock();
    player.reset();
    player.usePlayer.setState({
      nowPlaying: {
        connectionId: 'srv',
        libraryId: 1,
        path: 'a/book',
        queue: { chapters: [], total: 3600 },
      },
    });
  });
  afterEach(() => {
    Platform.OS = prevOS;
    document.body.innerHTML = '';
  });

  it('plays and pauses with Space over a focused slider (the timeline, the seek bar)', async () => {
    await renderHook(() => usePlayerShortcuts());
    expect(document.activeElement).toBe(document.body);
    const e = press(' ', { tag: 'div', role: 'slider' });
    expect(document.activeElement?.getAttribute('role')).toBe('slider');
    expect(mockRun).toHaveBeenCalledWith('toggle', expect.objectContaining({ onPlayer: false }));
    expect(e.defaultPrevented).toBe(true);
    // The arrows are the slider's.
    mockRun.mockClear();
    press('ArrowRight', { tag: 'div', role: 'slider' });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('skips with the arrows after a click on a button, and leaves the button Space', async () => {
    await renderHook(() => usePlayerShortcuts());
    press('ArrowRight', { tag: 'button' });
    expect(mockRun).toHaveBeenLastCalledWith('forward', expect.anything());
    mockRun.mockClear();
    const e = press(' ', { tag: 'button' });
    expect(mockRun).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('stands back while a dialog or a menu is open', async () => {
    await renderHook(() => usePlayerShortcuts());
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-state', 'open');
    document.body.appendChild(menu);
    expect(press('k').defaultPrevented).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
    menu.setAttribute('data-state', 'closed');
    press('k');
    expect(mockRun).toHaveBeenCalledWith('toggle', expect.anything());
  });
});
