import { fireEvent, render, screen, within } from '@testing-library/react-native';

import type { PodcastRequest } from '@/api/types';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
const mockOpenShow = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openPodcastShow: (...a: unknown[]) => mockOpenShow(...a) }),
}));
let mockRequests: PodcastRequest[] | undefined;
const mockAsked: unknown[][] = [];
jest.mock('@/api/hooks', () => ({
  useFollowRequests: (...a: unknown[]) => {
    mockAsked.push(a);
    return { data: mockRequests };
  },
}));

/* eslint-disable import/first */
import { FollowRequests } from './follow-requests';
/* eslint-enable import/first */

const request = (id: number, over: Partial<PodcastRequest> = {}): PodcastRequest => ({
  id,
  library_id: 7,
  state: 'queued',
  feed: `https://example.com/${id}.xml`,
  private: false,
  show_path: null,
  error: null,
  created_at: '2026-10-20T10:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
  ...over,
});

const mount = () => render(<FollowRequests connectionId="c1" libraryId={7} />);
const rowIds = () =>
  screen.getAllByTestId(/^follow-request-\d+$/).map((r) => Number(r.props.testID.slice(15)));

beforeEach(() => {
  mockFocused = true;
  mockRequests = undefined;
  mockAsked.length = 0;
  mockOpenShow.mockReset();
});

describe('FollowRequests', () => {
  it('shows nothing without requests', async () => {
    mockRequests = [];
    await mount();
    expect(screen.queryByTestId('follow-requests')).toBeNull();
  });

  it('polls only while its screen is focused', async () => {
    mockRequests = [request(1)];
    await mount();
    expect(mockAsked.at(-1)).toEqual([7, { active: true }, 'c1']);
    mockFocused = false;
    await screen.rerender(<FollowRequests connectionId="c1" libraryId={7} />);
    expect(mockAsked.at(-1)).toEqual([7, { active: false }, 'c1']);
  });

  it('lists every open request, then at most ten that ended', async () => {
    // The hook orders them (open first, newest first); the list keeps that order.
    mockRequests = [
      request(30, { state: 'running' }),
      request(29, { state: 'queued' }),
      ...Array.from({ length: 12 }, (_, i) => request(20 - i, { state: 'done' })),
    ];
    await mount();
    expect(rowIds()).toEqual([30, 29, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  });

  it('says each state in words, with the Private badge', async () => {
    mockRequests = [
      request(1, { state: 'queued', private: true }),
      request(2, { state: 'claimed' }),
      request(3, { state: 'cancelled' }),
    ];
    await mount();
    const row = (id: number) => within(screen.getByTestId(`follow-request-${id}`));
    expect(row(1).getByText('Waiting for its turn')).toBeTruthy();
    expect(row(1).getByText('Private feed')).toBeTruthy();
    expect(row(2).getByText('Adding')).toBeTruthy();
    expect(row(2).queryByText('Private feed')).toBeNull();
    expect(row(3).getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByTestId('follow-request-reason-3')).toBeNull();
  });

  it.each([
    ['dns', "Couldn't reach the feed."],
    ['not_a_feed', "That address isn't a podcast feed."],
    ['http_404', "The feed isn't there any more."],
    ['request_expired', 'Follow the feed again to finish adding it.'],
    ['something_new', 'Something went wrong adding it.'],
  ])('says why one failed (%s)', async (code, copy) => {
    mockRequests = [request(4, { state: 'failed', error: { code, message: 'x' } as never })];
    await mount();
    expect(screen.getByText("Couldn't add")).toBeTruthy();
    expect(screen.getByTestId('follow-request-reason-4').props.children).toBe(copy);
  });

  it('opens the show once it is added', async () => {
    mockRequests = [request(5, { state: 'done', show_path: 'Daily News' })];
    await mount();
    expect(screen.getByText('Added')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open show' }));
    expect(mockOpenShow).toHaveBeenCalledWith('c1', 7, 'Daily News');
  });

  it('offers no Open show for a request that is not done', async () => {
    mockRequests = [request(6, { state: 'running', show_path: 'Daily News' })];
    await mount();
    expect(screen.queryByRole('button', { name: 'Open show' })).toBeNull();
  });
});
