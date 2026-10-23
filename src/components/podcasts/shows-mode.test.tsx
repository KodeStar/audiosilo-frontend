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
jest.mock('@/api/hooks', () => ({
  usePodcastShows: () => ({ data: mockShows, isPending: false, refetch: jest.fn() }),
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
// The sub-nav row lives in the tab's chrome: here, only what is handed to it.
jest.mock('@/components/shell/tab-root-nav', () => ({
  SubNavActions: ({ children, id }: { children: React.ReactNode; id: string }) => {
    const { View } = jest.requireActual('react-native');
    return <View testID={`sub-nav-${id}`}>{children}</View>;
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
  mockAccess = 'allowed';
  mockOpenFind.mockReset();
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
