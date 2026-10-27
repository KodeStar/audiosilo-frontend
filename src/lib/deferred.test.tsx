import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

// `afterPaint` held by the test: it says when the page has painted.
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
import { deferred } from './deferred';
/* eslint-enable import/first */

function Hello({ name }: { name: string }) {
  return <Text>hello {name}</Text>;
}

const paint = async () => {
  await act(async () => {
    for (const fn of mockPainted.splice(0)) fn();
  });
};

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
});
