import { useRecentSearches } from '@/stores/search';

import { usePalette } from './palette-store';

jest.mock('@/stores/search', () => {
  const hydrate = jest.fn();
  return { useRecentSearches: { getState: () => ({ hydrate }) } };
});

describe('usePalette', () => {
  it('opens with a fresh query, reads the recent searches, and closes', () => {
    usePalette.setState({ query: 'old' });
    usePalette.getState().openPalette();
    expect(usePalette.getState()).toMatchObject({ open: true, query: '' });
    expect(useRecentSearches.getState().hydrate).toHaveBeenCalled();
    usePalette.getState().close();
    expect(usePalette.getState().open).toBe(false);
  });
});
