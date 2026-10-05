import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { Uniwind } from 'uniwind';

// global.css is compiled by Uniwind's Metro transformer; the Node test runtime can't
// parse it. Fonts and the splash screen are native modules.
jest.mock('@/global.css', () => ({}));
jest.mock('@expo-google-fonts/roboto', () => ({
  useFonts: () => [true],
  Roboto_300Light: 1,
  Roboto_400Regular: 2,
  Roboto_500Medium: 3,
  Roboto_600SemiBold: 4,
  Roboto_700Bold: 5,
}));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

/* eslint-disable import/first */
import { ThemeProvider, useTheme, type SchemePref } from './theme-provider';
/* eslint-enable import/first */

const PREFS: SchemePref[] = ['light', 'dark', 'system'];

function Probe() {
  const theme = useTheme();
  return (
    <>
      <Text testID="probe">{`${theme.pref}:${theme.scheme}`}</Text>
      {PREFS.map((p) => (
        <Pressable key={p} testID={`set-${p}`} onPress={() => theme.setPref(p)} />
      ))}
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

describe('ThemeProvider (Uniwind)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    Uniwind.setTheme('system');
  });

  it('defaults to dark when no preference is stored', async () => {
    await mount();
    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
    expect(Uniwind.currentTheme).toBe('dark');
    expect(Uniwind.hasAdaptiveThemes).toBe(false);
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
});
