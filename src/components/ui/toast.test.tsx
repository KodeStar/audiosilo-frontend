import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import * as screenReader from '@/lib/screen-reader';

import { dismissToast, pauseToast, resumeToast, toast, toastDuration, ToastHost } from './toast';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function mountHost() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ToastHost />
    </SafeAreaProvider>,
  );
}

describe('toast / ToastHost', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('shows a toast with its description in a polite live region, then dismisses itself', async () => {
    await mountHost();
    let id = 0;
    await act(async () => {
      id = toast({ title: 'Bookmark added', description: 'At 41:12 in chapter 23' });
    });
    expect(screen.getByText('Bookmark added')).toBeTruthy();
    expect(screen.getByText('At 41:12 in chapter 23')).toBeTruthy();
    expect(screen.getByLabelText('Notifications')).toHaveProp('accessibilityLiveRegion', 'polite');

    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('Bookmark added')).toBeNull();
    await act(async () => {
      dismissToast(id); // already gone: a no-op
    });
  });

  it('runs its one action and dismisses', async () => {
    await mountHost();
    const onPress = jest.fn();
    await act(async () => {
      toast({ title: 'Back where you were', action: { label: 'Undo', onPress } });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Back where you were')).toBeNull();
  });

  it('tells onClose when closed by hand (an answer), not when its action runs or it times out', async () => {
    await mountHost();
    const onClose = jest.fn();
    const onPress = jest.fn();
    await act(async () => {
      toast({ title: 'Offer', action: { label: 'Jump', onPress }, onClose, closeLabel: 'Stay' });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Stay' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();

    await act(async () => {
      toast({ title: 'Offer 2', action: { label: 'Jump', onPress }, onClose });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Jump' }));
    await act(async () => {
      toast({ title: 'Offer 3', onClose });
      jest.advanceTimersByTime(8000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('tells onTimeout only when it dismisses itself, never when answered', async () => {
    await mountHost();
    const onTimeout = jest.fn();
    const onPress = jest.fn();
    await act(async () => {
      toast({ title: 'Offer', action: { label: 'Jump', onPress }, onClose: jest.fn(), onTimeout });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Jump' }));
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(onTimeout).not.toHaveBeenCalled();
    await act(async () => {
      toast({ title: 'Offer 2', duration: 12_000, onTimeout });
      jest.advanceTimersByTime(12_000);
    });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Offer 2')).toBeNull();
  });

  it('can be dismissed by hand (a translated label)', async () => {
    await mountHost();
    await act(async () => {
      toast({ title: 'Download finished' });
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Download finished')).toBeNull();
  });

  it('keeps a stack of three, newest last', async () => {
    await mountHost();
    await act(async () => {
      ['one', 'two', 'three', 'four'].forEach((title) => toast({ title }));
    });
    expect(screen.queryByText('one')).toBeNull();
    expect(screen.getByText('four')).toBeTruthy();
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  });

  it('announces itself on iOS, which has no live regions', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'ios';
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    try {
      await mountHost();
      await act(async () => {
        toast({ title: 'Sleep timer set', description: 'Ends at 22:49' });
      });
      expect(announce).toHaveBeenCalledWith('Sleep timer set. Ends at 22:49');
    } finally {
      Platform.OS = prevOS;
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
    }
  });
});

describe('toast timing for a screen reader (fe#267)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps a toast with an action until answered, and a plain one three times as long', () => {
    expect(toastDuration({}, false)).toBe(5000);
    expect(toastDuration({ action: { label: 'Undo', onPress: jest.fn() } }, false)).toBe(8000);
    expect(toastDuration({ duration: 2000 }, false)).toBe(2000);
    expect(toastDuration({ action: { label: 'Undo', onPress: jest.fn() } }, true)).toBeNull();
    expect(toastDuration({}, true)).toBe(15000);
  });

  it('leaves an Undo on screen while VoiceOver or TalkBack is on', async () => {
    jest.spyOn(screenReader, 'screenReaderOn').mockReturnValue(true);
    await mountHost();
    let id = 0;
    await act(async () => {
      id = toast({ title: 'Removed', action: { label: 'Undo', onPress: jest.fn() } });
    });
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Removed')).toBeTruthy();
    await act(async () => {
      dismissToast(id);
    });
    expect(screen.queryByText('Removed')).toBeNull();
  });

  it('holds a paused toast and lets it run on for the time it had left', async () => {
    await mountHost();
    let id = 0;
    await act(async () => {
      id = toast({ title: 'Saved' });
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
      pauseToast(id);
      jest.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    await act(async () => {
      resumeToast(id);
      jest.advanceTimersByTime(1900);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
