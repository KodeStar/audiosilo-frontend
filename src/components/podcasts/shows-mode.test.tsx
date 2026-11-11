import { fireEvent, render, screen } from '@testing-library/react-native';

import type { PodcastShow } from '@/api/types';

let mockLayout = 'phone';
jest.mock('@/lib/layout', () => ({ useLayout: () => mockLayout }));
const mockOpenFind = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({
    openFindShows: (...a: unknown[]) => mockOpenFind(...a),
    openPodcastShow: jest.fn(),
  }),
}));
let mockShows: PodcastShow[] | undefined = [];
let mockShowsState: { isPending?: boolean; isPaused?: boolean; error?: unknown } = {};
const mockRefetch = jest.fn();
jest.mock('@/api/hooks', () => ({
  usePodcastShows: () => ({
    data: mockShows,
    isPending: false,
    isPaused: false,
    error: null,
    refetch: mockRefetch,
    ...mockShowsState,
  }),
}));
let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));
jest.mock('@/downloads/store', () => ({
  useDownloads: (select: (s: object) => unknown) => select({ supported: true }),
}));
jest.mock('@/components/library/cover-grid', () => ({
  CoverGrid: () => null,
  CoverGridSkeleton: () => null,
}));
jest.mock('./show-tile', () => ({ ShowTile: () => null }));
// The shelf draws book covers; here, only its words and its action.
jest.mock('@/components/series/empty-shelf', () => ({
  EmptyShelf: ({
    title,
    action,
  }: {
    title: string;
    action?: { label: string; onPress: () => void };
  }) => {
    const { Pressable, Text, View } = jest.requireActual('react-native');
    return (
      <View>
        <Text>{title}</Text>
        {action ? (
          <Pressable accessibilityRole="button" onPress={action.onPress}>
            <Text>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  },
}));
// The sub-nav row lives in the tab's chrome: here, only what is handed to it, and (as the
// real one does) the children right in place on a phone.
jest.mock('@/components/shell/tab-root-nav', () => ({
  SubNavActions: ({ children, id }: { children: React.ReactNode; id: string }) => {
    const { View } = jest.requireActual('react-native');
    return mockLayout === 'phone' ? children : <View testID={`sub-nav-${id}`}>{children}</View>;
  },
}));
let mockAccess = 'allowed';
jest.mock('./shows-actions', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useAddShowsAccess: () => mockAccess,
    ShowsActions: ({ libraryId }: { libraryId: number }) => (
      <Text testID="actions">{`actions ${libraryId}`}</Text>
    ),
    FollowRequestsNotice: () => <Text testID="notice">notice</Text>,
  };
});

/* eslint-disable import/first */
import { PodcastShowsMode } from './shows-mode';
/* eslint-enable import/first */

const mount = () => render(<PodcastShowsMode connectionId="c1" libraryId={7} />);

beforeEach(() => {
  mockLayout = 'phone';
  mockShows = [];
  mockShowsState = {};
  mockDeviceOnline = true;
  mockRefetch.mockReset();
  mockAccess = 'allowed';
  mockOpenFind.mockReset();
});

// The list is held for the network (it stays pending): the skeleton never ended where the
// mode used to fail with a Retry.
describe('PodcastShowsMode with no shows read', () => {
  it('shows the skeleton while the list loads, and Retry when it failed', async () => {
    mockShows = undefined;
    mockShowsState = { isPending: true };
    const loading = await mount();
    expect(screen.getByTestId('shows-mode-loading')).toBeTruthy();
    await loading.unmount();
    mockShowsState = { error: new TypeError('Network request failed') };
    await mount();
    expect(screen.queryByText("You're offline")).toBeNull();
    await fireEvent.press(screen.getByRole('button'));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('says offline, not a skeleton, while the list waits for the network', async () => {
    mockShows = undefined;
    mockShowsState = { isPending: true, isPaused: true };
    await mount();
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(
      screen.getByText(
        "This list shows once its server answers. Books you've downloaded are in Downloads.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('shows-mode-loading')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says offline, with no Retry, when the list failed with no network on the device', async () => {
    mockDeviceOnline = false;
    mockShows = undefined;
    mockShowsState = { error: new TypeError('Network request failed') };
    await mount();
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps showing the shows it holds while it is offline', async () => {
    mockDeviceOnline = false;
    mockShowsState = { isPaused: true };
    await mount();
    expect(screen.queryByText("You're offline")).toBeNull();
    expect(screen.getByText('No shows yet')).toBeTruthy();
  });
});

describe('PodcastShowsMode actions (Bridge Phase 2d-2)', () => {
  it('puts the actions above the shows on a phone, with the requests line', async () => {
    await mount();
    expect(screen.getByTestId('actions').props.children).toBe('actions 7');
    expect(screen.queryByTestId('sub-nav-shows-actions')).toBeNull();
    expect(screen.getByTestId('notice')).toBeTruthy();
  });

  it('hands them to the sub-nav row on a wider screen', async () => {
    mockLayout = 'desktop';
    await mount();
    expect(screen.getByTestId('sub-nav-shows-actions')).toBeTruthy();
    expect(screen.getAllByTestId('actions')).toHaveLength(1);
    expect(screen.getByTestId('notice')).toBeTruthy();
  });

  it('offers Add shows on an empty library to a listener who may add', async () => {
    await mount();
    await fireEvent.press(screen.getByRole('button', { name: 'Add shows' }));
    expect(mockOpenFind).toHaveBeenCalledWith('c1', 7);
  });

  it('keeps the plain empty state for one who may not', async () => {
    mockAccess = 'kid';
    await mount();
    expect(screen.queryByRole('button', { name: 'Add shows' })).toBeNull();
  });
});
