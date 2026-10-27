import { renderHook } from '@testing-library/react-native';

import type { LibrariesOfServer } from '@/api/hooks';

let mockGroups: LibrariesOfServer[] = [];
jest.mock('@/api/hooks', () => ({
  useLibrariesAll: () => ({ groups: mockGroups, retry: jest.fn() }),
}));

/* eslint-disable import/first */
import { useSelectedLibrary } from './use-selected-library';
/* eslint-enable import/first */

const group = (status: LibrariesOfServer['status'], paused = false): LibrariesOfServer => ({
  connectionId: 'a',
  connectionName: 'Home',
  libraries: [],
  status,
  paused,
});

describe('useSelectedLibrary', () => {
  it('is loading while a list is on its way', async () => {
    mockGroups = [group('loading')];
    const { result } = await renderHook(() => useSelectedLibrary());
    expect(result.current).toMatchObject({ isLoading: true, offline: false });
  });

  // A list the device went offline waiting for will not arrive meanwhile: no skeleton
  // for good, the offline state instead.
  it('is offline, not loading, while a list waits for the network', async () => {
    mockGroups = [group('loading', true)];
    const { result } = await renderHook(() => useSelectedLibrary());
    expect(result.current).toMatchObject({ isLoading: false, offline: true });
  });

  it('is neither once the lists are in', async () => {
    mockGroups = [group('ready')];
    const { result } = await renderHook(() => useSelectedLibrary());
    expect(result.current).toMatchObject({ isLoading: false, offline: false });
  });
});
