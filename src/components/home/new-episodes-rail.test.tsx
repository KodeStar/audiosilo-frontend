import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Library, MyPodcasts, PodcastEpisodePage } from '@/api/types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
// The tile has its own tests: here, what each says and where it goes.
jest.mock('@/components/library/cover-tile', () => ({
  useServerFlag: () => () => undefined,
  CoverTile: (p: { title: string; caption: string; path: string; book?: { episode?: object } }) => {
    const { Text } = jest.requireActual('react-native');
    return (
      <Text testID="tile">{`${p.title} | ${p.caption} | ${p.book?.episode ? 'episode' : ''}`}</Text>
    );
  },
}));
jest.mock('@/lib/format', () => ({
  ...jest.requireActual('@/lib/format'),
  formatRelative: (iso?: string) => (iso ? `when ${iso.slice(0, 10)}` : ''),
}));

const mockLibraries: Record<string, Library[]> = {};
const mockMine: Record<string, MyPodcasts> = {};
const mockEpisodes = jest.fn();
const mockMy = jest.fn();
const client = (cid: string) => ({
  libraries: async () => mockLibraries[cid] ?? [],
  myPodcasts: async () => {
    mockMy(cid);
    return mockMine[cid] ?? { shows: [], requests: [] };
  },
  podcastEpisodes: (...a: unknown[]) => mockEpisodes(cid, ...a),
});
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({ a: client('a'), b: client('b') }),
);

/* eslint-disable import/first */
import { useLibrarySelection } from '@/stores/library-selection';
import type { Connection } from '@/stores/session';
import { podcastEpisode, podcastShow } from '@/testing/podcast-fixtures';
import { settleFlashList } from '@/testing/flash-list';

import { NewEpisodesRail } from './new-episodes-rail';
/* eslint-enable import/first */

const recent = new Date(Date.now() - 86_400_000).toISOString();
const lib = (id: number, kind: Library['kind']) => ({ id, name: `L${id}`, kind }) as Library;
const page = (episodes: ReturnType<typeof podcastEpisode>[]): PodcastEpisodePage => ({
  episodes,
  next_cursor: null,
});

let qc: QueryClient;
afterEach(() => qc?.clear());

const mountRail = async (
  connections: { id: string }[] = [{ id: 'a' }],
  skip: Set<string> = new Set(),
) => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(
    <QueryClientProvider client={qc}>
      <NewEpisodesRail connections={connections as Connection[]} skip={skip} limit={15} />
    </QueryClientProvider>,
  );
  await settleFlashList();
};

beforeEach(() => {
  for (const k of Object.keys(mockLibraries)) delete mockLibraries[k];
  for (const k of Object.keys(mockMine)) delete mockMine[k];
  mockEpisodes.mockReset().mockResolvedValue(page([]));
  mockMy.mockReset();
  mockPush.mockReset();
  useLibrarySelection.setState({ selection: null });
});

describe('NewEpisodesRail', () => {
  it('shows the newest episodes of the shows followed, captioned with the show and when', async () => {
    mockLibraries.a = [lib(1, 'books'), lib(5, 'podcasts')];
    mockMine.a = { shows: [podcastShow({ latest_published: recent })], requests: [] };
    mockEpisodes.mockResolvedValue(
      page([
        podcastEpisode({ path: 'Daily News/new.mp3', title: 'New one', published: recent }),
        podcastEpisode({ path: 'Daily News/seen.mp3', title: 'Seen', published: recent }),
      ]),
    );
    await mountRail([{ id: 'a' }], new Set(['a:5:Daily News/seen.mp3']));
    await waitFor(() => expect(screen.getAllByTestId('tile')).toHaveLength(1));
    expect(screen.getByText('New episodes')).toBeTruthy();
    expect(screen.getByText('From shows you follow')).toBeTruthy();
    expect(screen.getByTestId('tile').props.children).toBe(
      `New one | Daily News · when ${recent.slice(0, 10)} | episode`,
    );
    // One page of the show's five newest.
    expect(mockEpisodes).toHaveBeenCalledWith(
      'a',
      5,
      { show: 'Daily News', order: 'newest', limit: 5 },
      expect.anything(),
    );

    await fireEvent.press(screen.getByRole('link', { name: 'All shows' }));
    expect(useLibrarySelection.getState().selection).toEqual({ connectionId: 'a', libraryId: 5 });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/library', params: { mode: 'shows' } });
  });

  it('asks only the servers with a podcast library, and only shows that published lately', async () => {
    mockLibraries.a = [lib(1, 'books')];
    mockLibraries.b = [lib(7, 'podcasts')];
    mockMine.b = {
      shows: [
        podcastShow({ library_id: 7, path: 'Quiet', latest_published: '2020-01-01T00:00:00Z' }),
      ],
      requests: [],
    };
    await mountRail([{ id: 'a' }, { id: 'b' }]);
    await waitFor(() => expect(mockMy).toHaveBeenCalledWith('b'));
    expect(screen.queryByText('New episodes')).toBeNull();
    expect(mockMy).not.toHaveBeenCalledWith('a');
    expect(mockEpisodes).not.toHaveBeenCalled();
  });

  it('renders nothing for someone following nothing', async () => {
    mockLibraries.a = [lib(5, 'podcasts')];
    await mountRail();
    await waitFor(() => expect(mockMy).toHaveBeenCalledWith('a'));
    expect(screen.queryByText('New episodes')).toBeNull();
    expect(mockEpisodes).not.toHaveBeenCalled();
  });
});
