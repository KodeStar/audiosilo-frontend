import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Dimensions, Platform } from 'react-native';

import type { Chapter } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';
import { playerStoreMock, type MockNowPlaying } from '@/testing/player-store-mock';
import { expectNativeTarget } from '@/testing/touch-target';

// The button and the sheet need only the sleep-timer store and the player store. Mock
// the player store (pulled in transitively through `sleep-timer`) so no engine / API
// layer loads in the test - the shared double the timer's own suite uses.
jest.mock('@/playback/store', () =>
  // `require` (not an import) because a jest.mock factory is hoisted above every import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { SleepSheet, SleepTimerButton } from '@/components/player/sleep-timer-button';
import { lastInteraction, resetInteractions } from '@/playback/last-interaction';
import { FADE_SECONDS, useSleepTimer } from '@/playback/sleep-timer';
import { useSettings } from '@/stores/settings';
/* eslint-enable import/first */

const player = playerStoreMock();

async function mount() {
  await act(async () => {
    render(<SleepTimerButton onPress={jest.fn()} />);
  });
}

function chapter(index: number, offset: number, length: number): Chapter {
  return {
    index,
    title: `Part ${index + 1}`,
    file_index: 0,
    file_path: 'b.m4b',
    start: 0,
    end: length,
    book_offset: offset,
  };
}

/** Six 10-minute chapters, 100 s into the first. */
function loadBook(extra: Partial<MockNowPlaying['queue']> = {}) {
  player.patch({
    nowPlaying: {
      connectionId: 'srv-1',
      libraryId: 1,
      path: 'b.m4b',
      queue: {
        chapters: Array.from({ length: 6 }, (_, i) => chapter(i, i * 600, 600)),
        total: 3600,
        ...extra,
      },
    },
    bookPosition: 100,
  });
}

describe('SleepTimerButton', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // A book that is playing: a duration timer's countdown freezes while the transport
    // is stopped, so a paused stand-in would never reach the ending window below.
    player.setPlayState('playing');
    useSleepTimer.getState().cancel();
  });

  afterEach(async () => {
    // Still mounted at this point (RNTL's own cleanup runs after ours), so the store
    // write has to be wrapped like any other.
    await act(async () => {
      useSleepTimer.getState().cancel();
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('announces the sheet it opens, both idle and while a timer merely runs', async () => {
    loadBook();
    await mount();
    expect(screen.getByLabelText('Sleep timer')).toBeTruthy();

    // A timer with 25 minutes left: tapping opens the sheet, exactly as when idle. The
    // a11y label overrides the visible children, so promising a screen-reader user "Keep
    // listening" here would describe a button that does no such thing. It says what is
    // running instead.
    await act(async () => {
      useSleepTimer.getState().startDuration(25);
    });
    expect(screen.getByLabelText('Sleep timer, 25 min, 25:00 left')).toBeTruthy();
    expect(screen.queryByLabelText('Keep listening')).toBeNull();
  });

  it('announces "Keep listening" once a tap would actually keep the book going', async () => {
    loadBook();
    await mount();
    await act(async () => {
      useSleepTimer.getState().startDuration(1);
    });
    // Into the ending window - one of the two windows where the tap re-arms the timer.
    await act(async () => {
      jest.advanceTimersByTime(60_000 - FADE_SECONDS * 1000);
    });
    expect(useSleepTimer.getState().phase).toBe('ending');
    expect(screen.getByLabelText('Keep listening')).toBeTruthy();
  });

  // STYLEGUIDE section 14: the pill is `h-9`, 31.5 pt on native (a 14 pt rem).
  it('takes a 44 pt touch on native, idle and with a timer', async () => {
    loadBook();
    await mount();
    expectNativeTarget(screen.getByLabelText('Sleep timer'));
    await act(async () => {
      useSleepTimer.getState().startDuration(25);
    });
    expectNativeTarget(screen.getByLabelText('Sleep timer, 25 min, 25:00 left'));
  });
});

describe('SleepSheet', () => {
  const prevOS = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 9, 7, 22, 0, 0));
    player.reset();
    player.setPlayState('playing');
    loadBook();
    resetInteractions();
    useSleepTimer.getState().cancel();
    useSettings.setState({
      autoSleepTimer: true,
      autoSleepFrom: '22:30',
      autoSleepUntil: '06:00',
      autoSleepType: '30',
      shakeToExtend: true,
      shakeSensitivity: 'medium',
    });
  });

  afterEach(async () => {
    Platform.OS = prevOS;
    await act(async () => {
      useSleepTimer.getState().cancel();
      Dimensions.set({ window: { width: 750, height: 1334, scale: 2, fontScale: 1 } });
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const isDialog = () => JSON.stringify(screen.toJSON()).includes('"role":"dialog"');

  async function open() {
    const onClose = jest.fn();
    await mountWithPortal(<SleepSheet visible onClose={onClose} />);
    return onClose;
  }

  it('arms a minute preset, notes the touch and closes', async () => {
    const onClose = await open();
    await fireEvent.press(screen.getByLabelText('30 min'));
    expect(useSleepTimer.getState().origin).toEqual({ kind: 'duration', minutes: 30 });
    expect(lastInteraction('srv-1:1:b.m4b')).toEqual({ at: Date.now(), position: 100 });
    expect(onClose).toHaveBeenCalled();
  });

  it('counts down to the end of the chapter on its tile, and arms it', async () => {
    await open();
    const tile = screen.getByLabelText('End of chapter, in 8m');
    await fireEvent.press(tile);
    expect(useSleepTimer.getState().pauseAtPosition).toBe(600);
  });

  it('offers this chapter and the next three, with clock end times', async () => {
    await open();
    expect(screen.getByText('Or stop after')).toBeTruthy();
    // 500 s to the end of chapter 1 at 1x: 22:08; each later one ten minutes on.
    expect(
      screen.getByLabelText(/^This chapter, Part 1, ends (22:08|10:08\sPM), 8m$/),
    ).toBeTruthy();
    expect(screen.getByLabelText(/^2 chapters, Part 2, ends (22:18|10:18\sPM), 18m$/)).toBeTruthy();
    expect(screen.getByLabelText(/^4 chapters, Part 4/)).toBeTruthy();
    expect(screen.queryByLabelText(/^5 chapters/)).toBeNull();

    await fireEvent.press(screen.getByLabelText(/^3 chapters/));
    const state = useSleepTimer.getState();
    expect(state.pauseAtPosition).toBe(1800);
    expect(state.label).toEqual({ key: 'player.sleepTimer.afterChapters', params: { count: 3 } });
  });

  /** Six 607 s chapters (their ends are not multiples of the sheet's 15 s step), the
   * listener at `position`. */
  function loadUnevenBook(position: number) {
    player.patch({
      nowPlaying: {
        connectionId: 'srv-1',
        libraryId: 1,
        path: 'b.m4b',
        queue: {
          chapters: Array.from({ length: 6 }, (_, i) => chapter(i, i * 607, 607)),
          total: 6 * 607,
        },
      },
      bookPosition: position,
    });
  }

  it('counts the rows from the chapter now playing just after a boundary', async () => {
    // 3 s into Part 2 (607..1214). Floored to 15 s the place (600) is still in Part 1,
    // which would make "This chapter" a chapter that has already ended.
    loadUnevenBook(610);
    await open();
    expect(screen.getByLabelText(/^2 chapters, Part 3, /)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/^This chapter, Part 2, ends .+, 10m$/));
    expect(useSleepTimer.getState().pauseAtPosition).toBe(1214);
  });

  it('arms exactly the end its End of chapter tile counts down to', async () => {
    // 29.5 s before the end of Part 2 (1214). The sheet counts from 1170 (its 15 s step),
    // where that end is 44 s away, past the tile's 30 s rule; picking again from the live
    // place on the press would stop at the end of Part 3 (1821) instead.
    loadUnevenBook(1184.5);
    await open();
    await fireEvent.press(screen.getByLabelText('End of chapter, in 44s'));
    const state = useSleepTimer.getState();
    expect(state.pauseAtPosition).toBe(1214);
    expect(state.origin).toEqual({ kind: 'chapter' });
  });

  it('measures the rows at the playback speed', async () => {
    player.patch({ rate: 2 });
    await open();
    expect(screen.getByLabelText(/^This chapter, Part 1, ends .+, 4m$/)).toBeTruthy();
  });

  it('offers no rows over synthetic chapters', async () => {
    loadBook({ syntheticChapters: true });
    await open();
    expect(screen.queryByText('Or stop after')).toBeNull();
  });

  it('says a duration timer fades out, with Turn off', async () => {
    useSleepTimer.getState().startDuration(25);
    await open();
    expect(screen.getByText('Sleep timer on')).toBeTruthy();
    expect(screen.getByText('25:00 left · fades out over the last 30 s')).toBeTruthy();
    await fireEvent.press(screen.getByText('Turn off'));
    expect(useSleepTimer.getState().phase).toBe('idle');
  });

  it('does not say a chapter timer fades, and counts its chapters', async () => {
    useSleepTimer.getState().startUntilPosition(1800, {
      key: 'player.sleepTimer.afterChapters',
      params: { count: 3 },
    });
    await open();
    expect(screen.getByText('Stopping after 3 chapters')).toBeTruthy();
    expect(screen.queryByText(/fades out/)).toBeNull();
    expect(screen.getByText('28:20 left')).toBeTruthy();
  });

  it('offers Keep listening in the last seconds', async () => {
    useSleepTimer.getState().startDuration(1);
    await act(async () => {
      jest.advanceTimersByTime(45_000);
    });
    await open();
    await fireEvent.press(screen.getByText('Keep listening'));
    expect(useSleepTimer.getState().phase).toBe('running');
    expect(useSleepTimer.getState().remaining).toBe(60);
  });

  it('shows the auto sleep window and binds the setting', async () => {
    await open();
    expect(
      screen.getByText(/^Starts a 30-minute timer whenever you press play between .+ and .+\.$/),
    ).toBeTruthy();
    await fireEvent(screen.getByLabelText('Auto sleep timer'), 'onCheckedChange', false);
    expect(useSettings.getState().autoSleepTimer).toBe(false);
  });

  it('offers shake to extend and its sensitivity on a phone', async () => {
    Platform.OS = 'ios';
    await open();
    expect(screen.getByLabelText('Shake to extend')).toBeTruthy();
    await fireEvent.press(screen.getByText('High'));
    expect(useSettings.getState().shakeSensitivity).toBe('high');
  });

  it('says shake is not available in the browser', async () => {
    Platform.OS = 'web';
    await open();
    expect(screen.getByText('Not available in the browser.')).toBeTruthy();
    expect(screen.getByLabelText('Shake to extend')).toBeDisabled();
    expect(screen.queryByText('Shake sensitivity')).toBeNull();
  });

  it('presents as a centred dialog on desktop', async () => {
    await act(async () => {
      Dimensions.set({ window: { width: 1440, height: 900, scale: 1, fontScale: 1 } });
    });
    await open();
    // The Dialog primitive's content (not an accessibility element itself, so by the tree).
    expect(isDialog()).toBe(true);
    expect(screen.getByText('Sleep timer')).toBeTruthy();
    expect(screen.getByLabelText('30 min')).toBeTruthy();
  });

  it('presents as a sheet below desktop', async () => {
    await open();
    expect(isDialog()).toBe(false);
    expect(screen.getByLabelText('30 min')).toBeTruthy();
  });
});
