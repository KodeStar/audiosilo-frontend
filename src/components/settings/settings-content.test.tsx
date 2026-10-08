import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('@/lib/layout', () => ({ useLayout: () => mockLayout }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
// The player's sheet pieces reach the playback store (a native module); its own suite
// covers the control.
jest.mock('@/components/player/sleep-timer-button', () => ({
  ShakeSensitivityControl: () => null,
}));
jest.mock('@/playback/use-shake-to-extend', () => ({ shakeAvailable: () => true }));
jest.mock('@/components/downloads/rules-card', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    KeepAheadControl: () => <RNText>keep-ahead</RNText>,
    KeepAheadStatusLine: () => null,
    useAutoDownloadModes: () => [
      { value: 'never', label: 'Never' },
      { value: 'wifi', label: 'On Wi-Fi' },
      { value: 'always', label: 'Always' },
    ],
  };
});
const mockOnRemove = jest.fn();
jest.mock('@/components/account/connections-section', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    ConnectionsSection: () => <RNText>servers-list</RNText>,
    useConnectionRemoval: () => ({ onRemove: mockOnRemove, dialog: null }),
  };
});
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'light', pref: 'system', setPref: jest.fn() }),
}));
jest.mock('@/i18n/language-provider', () => ({
  useLanguage: () => ({ pref: 'system', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { useSettings } from '@/stores/settings';

import { SettingsContent } from './settings-content';
/* eslint-enable import/first */

/** Lay the page out at `width` (its measured width decides split or stacked). */
async function layOut(width: number) {
  await fireEvent(screen.getByTestId('settings-content'), 'layout', {
    nativeEvent: { layout: { width, height: 800, x: 0, y: 0 } },
  });
}

const prevOS = Platform.OS;
beforeEach(() => {
  mockLayout = 'desktop';
  Platform.OS = 'web';
  useSettings.setState({ skipBackward: 15 });
});
afterEach(() => {
  Platform.OS = prevOS;
});

describe('SettingsContent, wide', () => {
  it('shows the grouped section nav beside the pane the link names', async () => {
    await render(<SettingsContent section="accounts" />);
    await layOut(1000);
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    for (const group of ['Listening', 'App', 'Servers']) {
      expect(screen.getByText(group)).toBeTruthy();
    }
    expect(screen.getByTestId('settings-pane-accounts')).toBeTruthy();
    expect(screen.getByText('servers-list')).toBeTruthy();
    expect(screen.getByTestId('settings-nav-accounts')).toHaveProp('aria-current', 'page');
    expect(screen.queryByTestId('settings-pane-playback')).toBeNull();
    expect(screen.getByRole('header', { name: 'Settings' })).toBeTruthy();
  });

  it('opens the first pane for preferences and moves between panes from the nav', async () => {
    const onSectionChange = jest.fn();
    await render(<SettingsContent section="preferences" onSectionChange={onSectionChange} />);
    await layOut(1000);
    expect(screen.getByTestId('settings-pane-playback')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-nav-sleep'));
    expect(onSectionChange).toHaveBeenCalledWith('sleep');
    expect(screen.getByTestId('settings-pane-sleep')).toBeTruthy();
    expect(screen.queryByTestId('settings-pane-playback')).toBeNull();
  });

  it('follows a new section from the route', async () => {
    const { rerender } = await render(<SettingsContent section="sleep" />);
    await layOut(1000);
    expect(screen.getByTestId('settings-pane-sleep')).toBeTruthy();
    await rerender(<SettingsContent section="accounts" />);
    expect(screen.getByTestId('settings-pane-accounts')).toBeTruthy();
  });

  it('stacks when the drawer leaves a desktop page narrow', async () => {
    await render(<SettingsContent />);
    await layOut(600);
    expect(screen.queryByTestId('settings-nav')).toBeNull();
    expect(screen.getByTestId('settings-section-playback')).toBeTruthy();
  });
});

describe('SettingsContent, stacked', () => {
  beforeEach(() => {
    mockLayout = 'phone';
  });

  it('shows every pane once, under its group', async () => {
    await render(<SettingsContent />);
    await layOut(390);
    for (const pane of [
      'playback',
      'sleep',
      'downloads',
      'appearance',
      'language',
      'household',
      'accounts',
      'support',
    ]) {
      expect(screen.getAllByTestId(`settings-section-${pane}`)).toHaveLength(1);
    }
    // Each setting lives in exactly one place.
    expect(screen.getAllByText('Skip back')).toHaveLength(1);
    expect(screen.getAllByText('Download automatically')).toHaveLength(1);
    expect(screen.getAllByText('keep-ahead')).toHaveLength(1);
    expect(screen.getByText('Arrives with profiles')).toBeTruthy();
    // No Journal row: the Journal lives in the You hub.
    expect(screen.queryByText('Journal')).toBeNull();
  });

  it('leaves the heading to the hub when embedded', async () => {
    await render(<SettingsContent embedded />);
    expect(screen.queryByRole('header', { name: 'Settings' })).toBeNull();
    await render(<SettingsContent />);
    expect(screen.getByRole('header', { name: 'Settings' })).toBeTruthy();
  });

  it('hides Support in an Apple build', async () => {
    Platform.OS = 'ios';
    await render(<SettingsContent section="support" />);
    expect(screen.queryByTestId('settings-section-support')).toBeNull();
    expect(screen.getByTestId('settings-section-accounts')).toBeTruthy();
  });

  it('binds the same store keys as before (skip back steps by 5)', async () => {
    await render(<SettingsContent />);
    await fireEvent.press(screen.getByLabelText('Skip back, more'));
    expect(useSettings.getState().skipBackward).toBe(20);
    await fireEvent.press(screen.getByLabelText('Skip back, less'));
    expect(useSettings.getState().skipBackward).toBe(15);
  });

  it('keeps the version line', async () => {
    await render(<SettingsContent />);
    expect(screen.getByText(/^AudioSilo v/)).toBeTruthy();
  });

  it('insets its scroller for the iOS tab bar itself, stacked and split', async () => {
    // In the You hub it sits under the segmented control, so react-native-screens does
    // not find it: "Add a server" and the version line scrolled under the tab bar.
    await render(<SettingsContent embedded />);
    await layOut(390);
    expect(screen.getByTestId('settings-scroll').props.contentInsetAdjustmentBehavior).toBe(
      'automatic',
    );
    mockLayout = 'desktop';
    await render(<SettingsContent />);
    await layOut(1200);
    expect(screen.getByTestId('settings-nav')).toBeTruthy();
    expect(screen.getByTestId('settings-scroll').props.contentInsetAdjustmentBehavior).toBe(
      'automatic',
    );
  });
});
