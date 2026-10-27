import { act, render, renderHook, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

// `afterPaint` held by the test: it says when the first screen has painted.
const mockPainted: (() => void)[] = [];
jest.mock('@/lib/after-paint', () => ({
  afterPaint: (fn: () => void) => {
    mockPainted.push(fn);
    return () => {
      const i = mockPainted.indexOf(fn);
      if (i >= 0) mockPainted.splice(i, 1);
    };
  },
}));

/* eslint-disable import/first */
import type * as Impl from './root-services-impl';
import { rootServices } from './root-services.web';
/* eslint-enable import/first */

const mockStop = jest.fn();
const mockStart = jest.fn(() => mockStop);
const load = jest.fn(() =>
  Promise.resolve({
    startRootServices: mockStart,
    RootListeners: () => <Text>listeners</Text>,
  } as unknown as typeof Impl),
);
const { RootListeners, useRootServices } = rootServices(load);

const paint = async () => {
  await act(async () => {
    for (const fn of mockPainted.splice(0)) fn();
  });
};

beforeEach(() => {
  mockPainted.length = 0;
  mockStart.mockClear();
  mockStop.mockClear();
  load.mockClear();
});

describe('root services (web)', () => {
  it('starts the services only once the first screen has painted, and stops them', async () => {
    const hook = await renderHook(() => useRootServices());
    expect(mockStart).not.toHaveBeenCalled();
    await paint();
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStop).not.toHaveBeenCalled();
    await hook.unmount();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it('never starts them when the root goes before the paint', async () => {
    const hook = await renderHook(() => useRootServices());
    await hook.unmount();
    await paint();
    expect(load).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('mounts the listeners after the paint', async () => {
    await render(
      <>
        <Text>page</Text>
        <RootListeners />
      </>,
    );
    expect(screen.queryByText('listeners')).toBeNull();
    await paint();
    expect(screen.getByText('listeners')).toBeTruthy();
  });
});
