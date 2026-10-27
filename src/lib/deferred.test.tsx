import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('@/lib/after-paint', () => require('@/testing/after-paint-mock'));

/* eslint-disable import/first */
import { paint, painted as mockPainted } from '@/testing/after-paint-mock';

import { DEFERRED_RETRY_MS, deferred } from './deferred';
/* eslint-enable import/first */

function Hello({ name }: { name: string }) {
  return <Text>hello {name}</Text>;
}

beforeEach(() => {
  mockPainted.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('deferred', () => {
  it('loads its module only after the page has painted, then renders it with its props', async () => {
    const load = jest.fn(() => Promise.resolve(Hello));
    const Deferred = deferred(load);
    await render(<Deferred name="ann" />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText('hello ann')).toBeNull();

    await paint();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('hello ann')).toBeTruthy();
  });

  it('renders at once when mounted again, without loading twice', async () => {
    const load = jest.fn(() => Promise.resolve(Hello));
    const Deferred = deferred(load);
    const first = await render(<Deferred name="ann" />);
    await paint();
    await first.unmount();

    await render(<Deferred name="bob" />);
    expect(screen.getByText('hello bob')).toBeTruthy();
    expect(mockPainted).toHaveLength(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never loads when unmounted before the paint', async () => {
    const load = jest.fn(() => Promise.resolve(Hello));
    const Deferred = deferred(load);
    const view = await render(<Deferred name="ann" />);
    await view.unmount();
    expect(mockPainted).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('stays empty when the load fails, and tries again on the next mount', async () => {
    const load = jest
      .fn<Promise<typeof Hello>, []>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(Hello);
    const Deferred = deferred(load);
    const first = await render(<Deferred name="ann" />);
    await paint();
    expect(screen.queryByText('hello ann')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
    await first.unmount();

    await render(<Deferred name="ann" />);
    await paint();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('hello ann')).toBeTruthy();
  });

  it('tries again a while after a failed load while it stays mounted (the root services)', async () => {
    jest.useFakeTimers();
    try {
      const load = jest
        .fn<Promise<typeof Hello>, []>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(Hello);
      const Deferred = deferred(load);
      await render(<Deferred name="ann" />);
      await paint();
      expect(screen.queryByText('hello ann')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(DEFERRED_RETRY_MS);
      });
      await paint();
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByText('hello ann')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
