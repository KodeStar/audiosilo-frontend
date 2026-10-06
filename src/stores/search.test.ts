import AsyncStorage from '@react-native-async-storage/async-storage';

import { addRecent, useRecentSearches } from './search';

const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = async () =>
  JSON.parse((await AsyncStorage.getItem('audiosilo.paletteRecent')) ?? '[]') as unknown;

describe('addRecent', () => {
  it('puts the newest first, trimmed, de-duplicated ignoring case, at most five', () => {
    expect(addRecent([], '  holmes ')).toEqual(['holmes']);
    expect(addRecent(['holmes', 'alice'], 'Alice')).toEqual(['Alice', 'holmes']);
    expect(addRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
    expect(addRecent(['a'], '   ')).toEqual(['a']);
  });
});

describe('useRecentSearches', () => {
  it('reads the stored list once, keeps searches made before the read newest, and clears', async () => {
    await AsyncStorage.setItem('audiosilo.paletteRecent', JSON.stringify(['alice', 7, 'dickens']));

    useRecentSearches.getState().hydrate();
    // A search remembered before the stored list arrives stays newest.
    useRecentSearches.getState().remember('holmes');
    await flush();
    expect(useRecentSearches.getState().recent).toEqual(['holmes', 'alice', 'dickens']);
    expect(await stored()).toEqual(['holmes', 'alice', 'dickens']);

    // A second hydrate (the other surface opening) reads nothing again.
    await AsyncStorage.setItem('audiosilo.paletteRecent', JSON.stringify(['other']));
    useRecentSearches.getState().hydrate();
    await flush();
    expect(useRecentSearches.getState().recent).toEqual(['holmes', 'alice', 'dickens']);

    useRecentSearches.getState().remember('Alice');
    expect(useRecentSearches.getState().recent).toEqual(['Alice', 'holmes', 'dickens']);
    expect(await stored()).toEqual(['Alice', 'holmes', 'dickens']);

    useRecentSearches.getState().clear();
    expect(useRecentSearches.getState().recent).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});
