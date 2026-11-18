import { ApiError, NetworkError, PodcastFetchPendingError } from '@/api/client';

import { failureTitle } from './failure-title';

const BUSY = 'The server is busy. Try again in a moment.';

describe('failureTitle', () => {
  it("says busy for a 503: the server's own, or a proxy's that carried no JSON", () => {
    expect(failureTitle(new ApiError(503, 'busy', 'request_timeout'), 'Failed')).toBe(BUSY);
    expect(failureTitle(new ApiError(503, 'Service Unavailable'), 'Failed')).toBe(BUSY);
  });

  it("is the action's own failure for anything else", () => {
    expect(failureTitle(new ApiError(500, 'boom'), 'Failed')).toBe('Failed');
    expect(failureTitle(new ApiError(502, 'bad gateway'), 'Failed')).toBe('Failed');
    expect(failureTitle(new NetworkError('offline'), 'Failed')).toBe('Failed');
    const fetching = new PodcastFetchPendingError('fetching', 'podcast_fetching', {} as never, 2);
    expect(failureTitle(fetching, 'Failed')).toBe('Failed');
  });
});
