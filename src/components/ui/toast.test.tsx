import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { dismissToast, toast, ToastHost } from './toast';

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
