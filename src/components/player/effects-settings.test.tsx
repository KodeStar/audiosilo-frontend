import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

// The browser rule is the effects module's own (tested there); here it is a switch.
const mockSupportsVoiceBoost = jest.fn(() => true);
jest.mock('@/playback/effects', () => ({
  ...jest.requireActual('@/playback/effects'),
  supportsVoiceBoost: () => mockSupportsVoiceBoost(),
}));

/* eslint-disable import/first */
import { useTimeSavedStore } from '@/playback/time-saved';
import { useSettings } from '@/stores/settings';

import { EffectsSettings } from './effects-settings';
/* eslint-enable import/first */

const realOS = Platform.OS;

beforeEach(() => {
  useSettings.setState({ smartSpeed: false, voiceBoost: false });
  useTimeSavedStore.setState({ lifetime: 0, books: {} });
  mockSupportsVoiceBoost.mockReturnValue(true);
});
afterEach(() => {
  Platform.OS = realOS;
});

describe('EffectsSettings', () => {
  it('binds both switches to their settings', async () => {
    Platform.OS = 'android';
    await render(<EffectsSettings />);
    await fireEvent.press(screen.getByLabelText('Smart speed'));
    expect(useSettings.getState().smartSpeed).toBe(true);
    await fireEvent.press(screen.getByLabelText('Voice boost'));
    expect(useSettings.getState().voiceBoost).toBe(true);
    expect(screen.getByText('Shortens the silences between words')).toBeTruthy();
  });

  it('shows the lifetime time saved under Smart Speed once there is some', async () => {
    Platform.OS = 'android';
    useTimeSavedStore.setState({ lifetime: 7860, books: {} });
    await render(<EffectsSettings />);
    expect(screen.getByText('Saved 2h 11m')).toBeTruthy();
  });

  it('on an iPhone, Smart Speed is disabled and says why, with the setting kept', async () => {
    Platform.OS = 'ios';
    useSettings.setState({ smartSpeed: true });
    useTimeSavedStore.setState({ lifetime: 7860, books: {} });
    await render(<EffectsSettings />);
    const sw = screen.getByLabelText('Smart speed');
    expect(sw).toBeDisabled();
    expect(sw).not.toBeChecked();
    expect(screen.getByText('Not available on iPhone yet')).toBeTruthy();
    expect(screen.queryByText('Saved 2h 11m')).toBeNull();
    expect(screen.getByLabelText('Voice boost')).not.toBeDisabled();
    // Android still reads the setting: iOS doesn't clear it.
    expect(useSettings.getState().smartSpeed).toBe(true);
  });

  it('on the web, Smart Speed is disabled and says why', async () => {
    Platform.OS = 'web';
    useSettings.setState({ smartSpeed: true });
    await render(<EffectsSettings />);
    expect(screen.getByLabelText('Smart speed')).toBeDisabled();
    expect(screen.getByText('Not available in the browser')).toBeTruthy();
    expect(screen.getByLabelText('Voice boost')).not.toBeDisabled();
  });

  it('in Safari, Voice Boost is disabled and says why', async () => {
    Platform.OS = 'web';
    mockSupportsVoiceBoost.mockReturnValue(false);
    await render(<EffectsSettings />);
    expect(screen.getByLabelText('Voice boost')).toBeDisabled();
    expect(screen.getByText('Not available in this browser')).toBeTruthy();
  });
});
