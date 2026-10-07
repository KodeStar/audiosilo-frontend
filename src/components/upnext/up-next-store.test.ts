import AsyncStorage from '@react-native-async-storage/async-storage';
import { Dimensions } from 'react-native';

import { usePlayerSheets } from '@/components/player/player-sheets';

import { closeUpNext, hydrateUpNext, openUpNext, toggleUpNext, useUpNext } from './up-next-store';

const setWidth = (width: number) =>
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 900, scale: 1, fontScale: 1 });

const sheetOpen = () => usePlayerSheets.getState().open === 'upnext';

beforeEach(() => usePlayerSheets.setState({ open: null }));
afterEach(() => jest.restoreAllMocks());

describe('up-next store', () => {
  it('remembers a drawer change made before hydration over the stored value', async () => {
    await AsyncStorage.setItem(
      'audiosilo.upNext',
      JSON.stringify({ drawerOpen: true, drawerWidth: 420 }),
    );
    setWidth(1440);
    closeUpNext(); // before the stored document is read
    await hydrateUpNext();
    expect(useUpNext.getState()).toMatchObject({ drawerOpen: false, drawerWidth: 420 });
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.upNext'))!)).toEqual({
      drawerOpen: false,
      drawerWidth: 420,
    });
  });

  it('toggles the drawer on a desktop and remembers it', async () => {
    setWidth(1440);
    openUpNext();
    expect(useUpNext.getState().drawerOpen).toBe(true);
    toggleUpNext();
    expect(useUpNext.getState().drawerOpen).toBe(false);
    expect(sheetOpen()).toBe(false);
    toggleUpNext();
    await Promise.resolve();
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.upNext'))!).drawerOpen).toBe(true);
  });

  it('opens the player sheet on a tablet or phone, never remembering it', async () => {
    setWidth(834);
    toggleUpNext();
    expect(sheetOpen()).toBe(true);
    const drawer = useUpNext.getState().drawerOpen;
    toggleUpNext();
    expect(sheetOpen()).toBe(false);
    expect(useUpNext.getState().drawerOpen).toBe(drawer);
    setWidth(400);
    openUpNext();
    expect(sheetOpen()).toBe(true);
    closeUpNext();
    expect(sheetOpen()).toBe(false);
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.upNext'))!)).not.toHaveProperty(
      'sheetOpen',
    );
  });

  it('replaces another player sheet, and closing leaves a sheet it did not open', () => {
    setWidth(400);
    usePlayerSheets.getState().openSheet('speed');
    toggleUpNext();
    expect(sheetOpen()).toBe(true);
    usePlayerSheets.getState().openSheet('sleep');
    closeUpNext();
    expect(usePlayerSheets.getState().open).toBe('sleep');
  });

  it('keeps the width between 300 and 480', async () => {
    useUpNext.getState().setDrawerWidth(1000);
    expect(useUpNext.getState().drawerWidth).toBe(480);
    useUpNext.getState().setDrawerWidth(120);
    expect(useUpNext.getState().drawerWidth).toBe(300);
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.upNext'))!).drawerWidth).toBe(300);
  });
});
