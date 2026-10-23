import type { PodcastRequest } from '@/api/types';

import { isOpenRequest, libraryRequests, requestsDone } from './podcast-requests';

const req = (id: number, state: string, over: Partial<PodcastRequest> = {}): PodcastRequest => ({
  id,
  library_id: 5,
  state,
  feed: 'https://f/...',
  private: false,
  show_path: null,
  error: null,
  created_at: `2026-10-${String(10 + id).padStart(2, '0')}T08:00:00Z`,
  updated_at: '2026-10-20T08:00:00Z',
  ...over,
});

describe('podcast follow requests', () => {
  it('tells the open states from the ended ones', () => {
    for (const s of ['queued', 'claimed', 'running', 'needs_attention']) {
      expect(isOpenRequest({ state: s })).toBe(true);
    }
    for (const s of ['done', 'failed', 'cancelled', 'something_new']) {
      expect(isOpenRequest({ state: s })).toBe(false);
    }
  });

  it("orders a library's requests open first, then newest first", () => {
    const list = [req(1, 'done'), req(2, 'queued'), req(3, 'failed'), req(4, 'running')];
    expect(
      libraryRequests([...list, req(9, 'queued', { library_id: 7 })], 5).map((r) => r.id),
    ).toEqual([4, 2, 3, 1]);
    expect(libraryRequests(list).map((r) => r.id)).toEqual([4, 2, 3, 1]);
  });

  it('names the requests that were open and have ended done', () => {
    const before = [req(1, 'queued'), req(2, 'running'), req(3, 'done')];
    const after = [req(1, 'done'), req(2, 'failed'), req(3, 'done'), req(4, 'done')];
    expect(requestsDone(before, after).map((r) => r.id)).toEqual([1]);
    expect(requestsDone(undefined, after)).toEqual([]);
  });
});
