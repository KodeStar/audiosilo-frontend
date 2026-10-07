import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

type Query = {
  data?: { pages: { items: { id: number }[]; next_cursor?: string }[]; pageParams: unknown[] };
  isError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: jest.Mock;
  refetch: jest.Mock;
};
const query = (over: Partial<Query> = {}): Query => ({
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
  refetch: jest.fn(),
  ...over,
});
const page = (...ids: number[]) => ({
  pages: [{ items: ids.map((id) => ({ id })) }],
  pageParams: [],
});

let mockQueries: Record<string, Query> = {};
let mockInfo: Record<
  string,
  { data?: { capabilities: object }; isError: boolean; refetch: jest.Mock }
> = {};
jest.mock('@/api/hooks', () => ({
  flattenPages: jest.requireActual('@/api/hooks').flattenPages,
  useAllHistory: (cid: string) => mockQueries[`history:${cid}`],
  useMyBookmarks: (cid: string) => mockQueries[`bookmarks:${cid}`],
  useMyNotes: (cid: string) => mockQueries[`notes:${cid}`],
  useServerInfo: (cid: string) => mockInfo[cid],
}));
let mockConnections = [
  { id: 'c1', name: 'Hearthside' },
  { id: 'c2', name: "Maya's Shelf" },
];
jest.mock('@/api/provider', () => ({
  useApis: () => mockConnections.map((connection) => ({ connection, client: {} })),
}));

/* eslint-disable import/first */
import { useJournalSources } from './use-journal-sources';
/* eslint-enable import/first */

/** The hook, with its feeders mounted as the screen mounts them. */
function Host({ onSources }: { onSources: (s: ReturnType<typeof useJournalSources>) => void }) {
  const sources = useJournalSources();
  onSources(sources);
  return sources.feeders as ReactNode;
}

let latest: ReturnType<typeof useJournalSources> | undefined;
const capture = (s: ReturnType<typeof useJournalSources>) => {
  latest = s;
};

async function mount() {
  const view = await render(<Host onSources={capture} />);
  return { view, current: () => latest! };
}

beforeEach(() => {
  mockConnections = [
    { id: 'c1', name: 'Hearthside' },
    { id: 'c2', name: "Maya's Shelf" },
  ];
  mockQueries = {
    'history:c1': query({ data: page(1, 2), hasNextPage: true }),
    'history:c2': query({ isError: true }),
    'bookmarks:c1': query({ data: page(5) }),
    'bookmarks:c2': query(),
    'notes:c1': query({ data: page() }),
    'notes:c2': query(),
  };
  mockInfo = {
    c1: { data: { capabilities: { annotations: true } }, isError: false, refetch: jest.fn() },
    c2: { data: { capabilities: {} }, isError: false, refetch: jest.fn() },
  };
});

describe('useJournalSources', () => {
  it("reports each server's lists, in connection order", async () => {
    const { current } = await mount();
    await waitFor(() => expect(current().history[0].status).toBe('ready'));
    const { history, bookmarks, notes } = current();
    expect(history.map((s) => [s.connectionName, s.status, s.rows.length, s.hasNextPage])).toEqual([
      ['Hearthside', 'ready', 2, true],
      ["Maya's Shelf", 'error', 0, false],
    ]);
    // c2 has no `annotations`: it can't list them, never a load.
    expect(bookmarks.map((s) => s.status)).toEqual(['ready', 'unsupported']);
    expect(notes.map((s) => s.status)).toEqual(['ready', 'unsupported']);
  });

  it('reads a server whose /server failed as failed, and its retry asks /server again', async () => {
    mockInfo.c2 = { isError: true, refetch: jest.fn() };
    const { current } = await mount();
    await waitFor(() => expect(current().bookmarks[1].status).toBe('error'));
    current().bookmarks[1].refetch();
    expect(mockInfo.c2.refetch).toHaveBeenCalled();
    expect(mockQueries['bookmarks:c2'].refetch).toHaveBeenCalled();
  });

  it('loads while a flag is not known yet, and pages through the query', async () => {
    mockInfo.c2 = { isError: false, refetch: jest.fn() };
    const { current } = await mount();
    await waitFor(() => expect(current().history[0].status).toBe('ready'));
    expect(current().bookmarks[1].status).toBe('loading');
    current().history[0].fetchNextPage();
    expect(mockQueries['history:c1'].fetchNextPage).toHaveBeenCalled();
  });

  it('drops a removed server', async () => {
    const { view, current } = await mount();
    await waitFor(() => expect(current().history[0].status).toBe('ready'));
    mockConnections = [{ id: 'c1', name: 'Hearthside' }];
    await view.rerender(<Host onSources={capture} />);
    expect(current().history.map((s) => s.connectionId)).toEqual(['c1']);
    expect(current().bookmarks.map((s) => s.connectionId)).toEqual(['c1']);
  });
});
