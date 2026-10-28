/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

// One server, answering when the test says (the page is `/`: Home).
let release!: () => void;
const gate = new Promise<void>((r) => (release = r));
const answer =
  <T,>(value: T) =>
  async () => {
    await gate;
    return value;
  };
const mockClient = {
  serverInfo: jest.fn(answer({ version: 'x', capabilities: {} })),
  libraries: jest.fn(answer([{ id: 1, name: 'Books' }])),
  allProgress: jest.fn(answer([])),
  recentBooks: jest.fn(answer([{ path: 'A/B' }])),
  favourites: jest.fn(answer([])),
};
jest.mock('@/api/provider', () =>
  // `require` because a jest.mock factory is hoisted above every import; the methods call
  // through, as `mockClient` is only defined once the module body runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({
    c: {
      serverInfo: () => mockClient.serverInfo(),
      libraries: () => mockClient.libraries(),
      allProgress: () => mockClient.allProgress(),
      recentBooks: () => mockClient.recentBooks(),
      favourites: () => mockClient.favourites(),
    },
  }),
);

/* eslint-disable import/first */
import { qk, RECENT_LIMIT } from '@/api/hooks';

import { resetStartupQueries } from './startup-queries';
import { useStartupQueries } from './use-startup-queries.web';
/* eslint-enable import/first */

beforeEach(() => resetStartupQueries());

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

it('holds the first screen until its answers are in, which land under the screens own keys', async () => {
  const { client, wrapper } = setup();
  const { result, rerender } = await renderHook(
    ({ open }: { open: boolean }) => useStartupQueries(open),
    {
      wrapper,
      initialProps: { open: false },
    },
  );
  // Not open yet (the session or the person still loading): nothing asked.
  expect(result.current).toBe(true);
  expect(mockClient.serverInfo).not.toHaveBeenCalled();

  await rerender({ open: true });
  expect(result.current).toBe(false);
  expect(mockClient.recentBooks).toHaveBeenCalledTimes(1);

  await act(async () => release());
  expect(result.current).toBe(true);
  expect(client.getQueryData(qk.recent('c', RECENT_LIMIT))).toEqual([{ path: 'A/B' }]);
  expect(client.getQueryData(qk.server('c'))).toEqual({ version: 'x', capabilities: {} });

  // Opening again (a later sign-in, a re-render) asks nothing more.
  await rerender({ open: false });
  await rerender({ open: true });
  expect(result.current).toBe(true);
  expect(mockClient.recentBooks).toHaveBeenCalledTimes(1);
});
