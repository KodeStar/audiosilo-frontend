import { fireEvent, screen } from '@testing-library/react-native';

import type { PodcastRequest } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
const mockOpenFind = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openFindShows: (...a: unknown[]) => mockOpenFind(...a) }),
}));
const mockRun = jest.fn();
jest.mock('./opml-export', () => ({
  useExportShows: () => ({ run: () => mockRun(), busy: false }),
}));
let mockCaps: Record<string, boolean | undefined> = {};
let mockRequests: Partial<PodcastRequest>[] | undefined;
const mockRequestsAsked: unknown[][] = [];
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string) => mockCaps[flag],
  useFollowRequests: (...a: unknown[]) => {
    mockRequestsAsked.push(a);
    return { data: mockRequests };
  },
}));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';

import { FollowRequestsNotice, ShowsActions } from './shows-actions';
/* eslint-enable import/first */

const signIn = (user: object = {}) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockFocused = true;
  mockCaps = { podcasts: true, podcast_opml: true };
  mockRequests = undefined;
  mockRequestsAsked.length = 0;
  mockOpenFind.mockReset();
  mockRun.mockReset();
  signIn();
});

describe('ShowsActions', () => {
  it('opens Find shows for this library', async () => {
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    await fireEvent.press(screen.getByTestId('shows-add'));
    expect(mockOpenFind).toHaveBeenCalledWith('c1', 7);
  });

  it('exports from its menu', async () => {
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    await fireEvent.press(screen.getByTestId('shows-menu'));
    await fireEvent.press(await screen.findByTestId('shows-export'));
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('keeps Export while the module is off (it needs only podcast_opml)', async () => {
    mockCaps = { podcasts: false, podcast_opml: true };
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    expect(screen.queryByTestId('shows-add')).toBeNull();
    expect(screen.getByTestId('shows-menu')).toBeTruthy();
  });

  it('has no menu without podcast_opml', async () => {
    mockCaps = { podcasts: true, podcast_opml: false };
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    expect(screen.getByTestId('shows-add')).toBeTruthy();
    expect(screen.queryByTestId('shows-menu')).toBeNull();
  });

  it("offers a kid's account nothing to add, but its export stays", async () => {
    signIn({ member_kind: 'kid' });
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    expect(screen.queryByTestId('shows-add')).toBeNull();
    expect(screen.getByTestId('shows-menu')).toBeTruthy();
  });

  it('offers the demo nothing at all', async () => {
    signIn({ is_demo: true });
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    expect(screen.queryByTestId('shows-actions')).toBeNull();
  });

  it('is nothing on a server without either', async () => {
    mockCaps = { podcasts: false, podcast_opml: false };
    await mountWithPortal(<ShowsActions connectionId="c1" libraryId={7} />);
    expect(screen.queryByTestId('shows-actions')).toBeNull();
  });
});

describe('FollowRequestsNotice', () => {
  it('counts the shows being added and opens Find shows', async () => {
    mockRequests = [{ state: 'queued' }, { state: 'running' }, { state: 'done' }];
    await mountWithPortal(<FollowRequestsNotice connectionId="c1" libraryId={7} />);
    expect(screen.getByRole('button', { name: 'Adding 2 shows' })).toBeTruthy();
    await fireEvent.press(screen.getByTestId('shows-requests-notice'));
    expect(mockOpenFind).toHaveBeenCalledWith('c1', 7);
    expect(mockRequestsAsked.at(-1)).toEqual([7, { active: true }, 'c1']);
  });

  it('is nothing once every request has ended, and polls only while focused', async () => {
    mockFocused = false;
    mockRequests = [{ state: 'done' }, { state: 'failed' }];
    await mountWithPortal(<FollowRequestsNotice connectionId="c1" libraryId={7} />);
    expect(screen.queryByTestId('shows-requests-notice')).toBeNull();
    expect(mockRequestsAsked.at(-1)).toEqual([7, { active: false }, 'c1']);
  });
});
