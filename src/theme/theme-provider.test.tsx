import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { Uniwind } from 'uniwind';

// global.css is compiled by Uniwind's Metro transformer; the Node test runtime can't
// parse it. Fonts and the splash screen are native modules.
jest.mock('@/global.css', () => ({}));
const mockFontLoaded = jest.fn((_family: string) => true);
jest.mock('expo-font', () => ({
  // Loaded when every family in the map is.
  useFonts: (map: Record<string, unknown>) => [
    Object.keys(map).every((family) => mockFontLoaded(family)),
    null,
  ],
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));
// The OS contrast signal (per platform in ./os-contrast), driven by the tests.
let mockOsContrast = false;
let mockOsListener: ((on: boolean) => void) | undefined;
jest.mock('./os-contrast', () => ({
  readOsHighContrast: () => Promise.resolve(mockOsContrast),
  watchOsHighContrast: (onChange: (on: boolean) => void) => {
    mockOsListener = onChange;
    return () => {
      mockOsListener = undefined;
    };
  },
}));

/* eslint-disable import/first */
import { forgetStorageMigration } from '@/lib/storage-migration';

import { applyHighContrast } from './high-contrast';
import { colors } from './tokens';
import { ThemeProvider, useTheme, type SchemePref } from './theme-provider';
import { useThemeColors } from './use-theme-colors';
/* eslint-enable import/first */

const PREFS: SchemePref[] = ['light', 'dark', 'system'];

function Probe() {
  const theme = useTheme();
  const themed = useThemeColors();
  return (
    <>
      <Text testID="probe">{`${theme.pref}:${theme.scheme}`}</Text>
      <Text testID="contrast">
        {`${theme.highContrast}:${theme.highContrastPref}:${theme.osHighContrast}`}
      </Text>
      <Text testID="muted">{themed.mutedForeground}</Text>
      <Pressable testID="hc-on" onPress={() => theme.setHighContrastPref(true)} />
      <Pressable testID="hc-off" onPress={() => theme.setHighContrastPref(false)} />
      {PREFS.map((p) => (
        <Pressable key={p} testID={`set-${p}`} onPress={() => theme.setPref(p)} />
      ))}
      <Pressable testID="toggle" onPress={theme.toggleScheme} />
    </>
  );
}

async function choose(p: SchemePref) {
  await fireEvent.press(screen.getByTestId(`set-${p}`));
}

async function mount() {
  await render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

const updateVars = jest.spyOn(Uniwind, 'updateCSSVariables');

/** The muted text colour the theme variables were last set to for `scheme`. */
const lastMuted = (scheme: 'light' | 'dark') =>
  updateVars.mock.calls.filter(([s]) => s === scheme).at(-1)?.[1]['--color-muted-foreground'];

describe('ThemeProvider (Uniwind)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    Uniwind.setTheme('system');
    // Each test is a fresh launch: the launch migration runs again.
    forgetStorageMigration();
    mockFontLoaded.mockImplementation(() => true);
    mockOsContrast = false;
    mockOsListener = undefined;
    // A fresh launch starts on the normal colours.
    applyHighContrast(false);
    updateVars.mockClear();
  });

  it('follows the system on a new install, and writes that down', async () => {
    await mount();
    expect(Uniwind.hasAdaptiveThemes).toBe(true);
    expect(screen.getByTestId('probe')).toHaveTextContent(`system:${Uniwind.currentTheme}`);
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('system'));
  });

  it('keeps an existing install that never chose a theme dark, and writes that down', async () => {
    await AsyncStorage.setItem('audiosilo.connections', JSON.stringify([{ id: 's1' }]));
    await mount();
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(Uniwind.currentTheme).toBe('dark');
    expect(Uniwind.hasAdaptiveThemes).toBe(false);
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('dark'));
  });

  it('reads the install signal before the launch reset wipes the connections', async () => {
    // A pre-v2 install (no auth version): the reset clears its connections, but the theme
    // default was decided first.
    await AsyncStorage.setItem('audiosilo.connections', JSON.stringify([{ id: 's1' }]));
    await mount();
    expect(await AsyncStorage.getItem('audiosilo.connections')).toBeNull();
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('dark'));
  });

  it('keeps a stored pick, even on a new install', async () => {
    await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('dark'));
    await mount();
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('dark'));
  });

  it('paints without waiting for the deferred mono font', async () => {
    mockFontLoaded.mockImplementation((family) => family !== 'JetBrainsMono_500Medium');
    await mount();
    expect(screen.getByTestId('probe')).toBeTruthy();
  });

  it('waits for the gating fonts', async () => {
    mockFontLoaded.mockImplementation((family) => family !== 'Figtree_400Regular');
    await mount();
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('toggles to the other explicit scheme', async () => {
    await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
    await mount();
    await fireEvent.press(screen.getByTestId('toggle'));
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('dark'));
  });

  it('falls back to dark for a stored value it does not know (never wedges the splash)', async () => {
    // Uniwind.setTheme throws on an unregistered name; an unvalidated restore used to
    // abort hydration, so the provider rendered nothing and the splash never hid.
    await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('auto'));
    await mount();
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(Uniwind.currentTheme).toBe('dark');
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('auto'));
  });

  it('restores a persisted preference into Uniwind', async () => {
    await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
    await mount();
    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(Uniwind.currentTheme).toBe('light');
  });

  it('switches, persists, and resolves "system" to the OS scheme', async () => {
    await mount();
    await choose('light');
    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('light'));

    await choose('system');
    expect(Uniwind.hasAdaptiveThemes).toBe(true);
    // `scheme` is the RESOLVED theme (never 'system'): whatever the OS reports.
    const resolved = Uniwind.currentTheme;
    expect(['light', 'dark']).toContain(resolved);
    expect(screen.getByTestId('probe')).toHaveTextContent(`system:${resolved}`);
    expect(await AsyncStorage.getItem('audiosilo.theme')).toBe(JSON.stringify('system'));
  });

  describe('high contrast', () => {
    it('is off by default and leaves the theme variables alone', async () => {
      await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
      await mount();
      expect(screen.getByTestId('contrast')).toHaveTextContent('false:false:false');
      expect(screen.getByTestId('muted')).toHaveTextContent(colors.light.mutedForeground);
      expect(updateVars).not.toHaveBeenCalled();
    });

    it('turns on with the switch, persists it, and writes the normal colours back off', async () => {
      await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
      await mount();
      await fireEvent.press(screen.getByTestId('hc-on'));
      expect(screen.getByTestId('contrast')).toHaveTextContent('true:true:false');
      expect(screen.getByTestId('muted')).toHaveTextContent(
        colors.highContrast.light.mutedForeground,
      );
      expect(lastMuted('light')).toBe(colors.highContrast.light.mutedForeground);
      expect(lastMuted('dark')).toBe(colors.highContrast.dark.mutedForeground);
      expect(await AsyncStorage.getItem('audiosilo.highContrast')).toBe('true');

      await fireEvent.press(screen.getByTestId('hc-off'));
      expect(screen.getByTestId('contrast')).toHaveTextContent('false:false:false');
      expect(lastMuted('light')).toBe(colors.light.mutedForeground);
      expect(lastMuted('dark')).toBe(colors.dark.mutedForeground);
      expect(await AsyncStorage.getItem('audiosilo.highContrast')).toBe('false');
    });

    it('restores the switch before first paint, and keeps it across a scheme change', async () => {
      await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
      await AsyncStorage.setItem('audiosilo.highContrast', JSON.stringify(true));
      await mount();
      expect(screen.getByTestId('contrast')).toHaveTextContent('true:true:false');
      expect(lastMuted('light')).toBe(colors.highContrast.light.mutedForeground);
      await choose('dark');
      expect(screen.getByTestId('muted')).toHaveTextContent(
        colors.highContrast.dark.mutedForeground,
      );
    });

    it('keeps the stored theme and normal contrast when the variables cannot be written', async () => {
      await AsyncStorage.setItem('audiosilo.theme', JSON.stringify('light'));
      await AsyncStorage.setItem('audiosilo.highContrast', JSON.stringify(true));
      updateVars.mockImplementationOnce(() => {
        throw new Error('no variable store');
      });
      await mount();
      expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
      expect(screen.getByTestId('contrast')).toHaveTextContent('false:false:false');
      expect(screen.getByTestId('muted')).toHaveTextContent(colors.light.mutedForeground);
    });

    it('ignores a stored value that is not true', async () => {
      await AsyncStorage.setItem('audiosilo.highContrast', JSON.stringify('yes'));
      await mount();
      expect(screen.getByTestId('contrast')).toHaveTextContent('false:false:false');
    });

    it('follows the OS when the switch is off, at launch and on a change', async () => {
      mockOsContrast = true;
      await mount();
      expect(screen.getByTestId('contrast')).toHaveTextContent('true:false:true');

      await act(async () => mockOsListener?.(false));
      expect(screen.getByTestId('contrast')).toHaveTextContent('false:false:false');
      expect(lastMuted('dark')).toBe(colors.dark.mutedForeground);

      await act(async () => mockOsListener?.(true));
      expect(screen.getByTestId('contrast')).toHaveTextContent('true:false:true');
      expect(lastMuted('dark')).toBe(colors.highContrast.dark.mutedForeground);
    });

    it('stays on with the switch when the OS stops asking', async () => {
      mockOsContrast = true;
      await AsyncStorage.setItem('audiosilo.highContrast', JSON.stringify(true));
      await mount();
      await act(async () => mockOsListener?.(false));
      expect(screen.getByTestId('contrast')).toHaveTextContent('true:true:false');
    });
  });
});
