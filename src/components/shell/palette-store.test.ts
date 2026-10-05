import AsyncStorage from '@react-native-async-storage/async-storage';

import { usePalette } from './palette-store';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('usePalette', () => {
  it('opens with a fresh query, reads the stored recent searches once, and keeps new ones', async () => {
    await AsyncStorage.setItem('audiosilo.paletteRecent', JSON.stringify(['alice', 7, 'dickens']));
    usePalette.setState({ query: 'old' });

    usePalette.getState().openPalette();
    expect(usePalette.getState()).toMatchObject({ open: true, query: '' });
    // A search remembered before the stored list arrives stays newest.
    usePalette.getState().remember('holmes');
    await flush();
    expect(usePalette.getState().recent).toEqual(['holmes', 'alice', 'dickens']);
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.paletteRecent')) ?? '[]')).toEqual([
      'holmes',
      'alice',
      'dickens',
    ]);

    usePalette.getState().close();
    expect(usePalette.getState().open).toBe(false);
    usePalette.getState().remember('Alice');
    expect(usePalette.getState().recent).toEqual(['Alice', 'holmes', 'dickens']);
    expect(JSON.parse((await AsyncStorage.getItem('audiosilo.paletteRecent')) ?? '[]')).toEqual([
      'Alice',
      'holmes',
      'dickens',
    ]);
  });
});
