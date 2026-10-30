import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

// The downloads registry as the hook reads it: its rows and whether the launch read it.
jest.mock('@/downloads/store', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require('zustand');
  return { useDownloads: create(() => ({ entries: {}, hydrated: true })) };
});
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({ useDeviceOnline: () => mockDeviceOnline }));

/* eslint-disable import/first */
import { useReachability } from '@/api/reachability';
import { useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';

import { usePlayableHere } from './use-playable-here';
/* eslint-enable import/first */

const kept = { connectionId: 'a', libraryId: 1, path: 'Kept' };
const streamed = { connectionId: 'a', libraryId: 1, path: 'Streamed' };
const defaultOS = Platform.OS;
// The registry as the hook reads it: only the status of each row.
const keptRows = { 'a:1:Kept': { status: 'downloaded' } } as unknown as Record<
  string,
  DownloadEntry
>;

beforeEach(() => {
  mockDeviceOnline = true;
  useReachability.setState({ online: {} });
  useDownloads.setState({ entries: keptRows, hydrated: true });
});

afterEach(() => {
  Platform.OS = defaultOS;
});

describe('usePlayableHere', () => {
  it('a book not downloaded plays while its server answers, a downloaded one always', async () => {
    const { result } = await renderHook(() => usePlayableHere());
    expect(result.current(streamed)).toBe(true);
    await act(async () => useReachability.setState({ online: { a: false } }));
    expect(result.current(streamed)).toBe(false);
    expect(result.current(kept)).toBe(true);
  });

  it('in the app, a device flag of no internet leaves it to the server (a LAN server answers)', async () => {
    Platform.OS = 'android';
    mockDeviceOnline = false;
    const { result } = await renderHook(() => usePlayableHere());
    expect(result.current(streamed)).toBe(true);
  });

  it('on the web, a browser with no network plays only what is downloaded', async () => {
    Platform.OS = 'web';
    mockDeviceOnline = false;
    const { result } = await renderHook(() => usePlayableHere());
    expect(result.current(streamed)).toBe(false);
    expect(result.current(kept)).toBe(true);
  });

  it('calls nothing unplayable before the launch has read the downloads', async () => {
    useDownloads.setState({ entries: {}, hydrated: false });
    useReachability.setState({ online: { a: false } });
    const { result } = await renderHook(() => usePlayableHere());
    expect(result.current(kept)).toBe(true);
    await act(async () => useDownloads.setState({ entries: keptRows, hydrated: true }));
    expect(result.current(kept)).toBe(true);
    expect(result.current(streamed)).toBe(false);
  });
});
