import AsyncStorage from '@react-native-async-storage/async-storage';

import { useSeriesOrderings } from '@/stores/series-orderings';

const KEY = 'audiosilo.seriesOrderings';

// Exercises the real store over the in-memory AsyncStorage mock (jest.setup).
describe('series orderings store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useSeriesOrderings.setState({ picks: {}, hydrated: false });
    jest.clearAllMocks();
  });

  it('starts with no picks', () => {
    expect(useSeriesOrderings.getState().picks).toEqual({});
  });

  it('persists a pick per family', async () => {
    await useSeriesOrderings.getState().hydrate();
    useSeriesOrderings.getState().pick('narnia', 'narnia-chronological');
    useSeriesOrderings.getState().pick('pern', 'pern');
    expect(useSeriesOrderings.getState().picks).toEqual({
      narnia: 'narnia-chronological',
      pern: 'pern',
    });
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toEqual({
      narnia: 'narnia-chronological',
      pern: 'pern',
    });
  });

  it('does not rewrite storage for a pick that is already current', async () => {
    await useSeriesOrderings.getState().hydrate();
    useSeriesOrderings.getState().pick('narnia', 'narnia');
    (AsyncStorage.setItem as jest.Mock).mockClear();
    useSeriesOrderings.getState().pick('narnia', 'narnia');
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('hydrates the remembered picks', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ narnia: 'narnia-chronological' }));
    await useSeriesOrderings.getState().hydrate();
    expect(useSeriesOrderings.getState().picks).toEqual({ narnia: 'narnia-chronological' });
    expect(useSeriesOrderings.getState().hydrated).toBe(true);
  });

  it('keeps a pick made before hydration finished over the stored one', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ narnia: 'narnia', pern: 'pern' }));
    useSeriesOrderings.getState().pick('narnia', 'narnia-chronological');
    await useSeriesOrderings.getState().hydrate();
    const merged = { narnia: 'narnia-chronological', pern: 'pern' };
    expect(useSeriesOrderings.getState().picks).toEqual(merged);
    // The early pick never clobbered the stored document; the merge is what lands.
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toEqual(merged);
  });

  it('survives a corrupt stored document', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify(['not', 'picks']));
    await useSeriesOrderings.getState().hydrate();
    expect(useSeriesOrderings.getState().picks).toEqual({});
    expect(useSeriesOrderings.getState().hydrated).toBe(true);
  });
});
