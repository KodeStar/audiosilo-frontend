import {
  ARTWORK_BUSY_MAX_WAITS,
  type ArtworkProbe,
  nextArtworkTry,
  probeArtwork,
  resetArtworkBusy,
} from './artwork-retry';

const URI = 'https://s/api/v1/podcasts/discovery/artwork?id=abc&token=m';
const answers = (a: ArtworkProbe | null) => jest.fn(async (_uri: string) => a);

beforeEach(() => {
  resetArtworkBusy();
  jest.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => jest.restoreAllMocks());

describe('nextArtworkTry (fe#126)', () => {
  it("waits the server's Retry-After while it is busy, without using up a try", async () => {
    for (const status of [429, 503]) {
      resetArtworkBusy();
      const probe = answers({ status, retryAfterSeconds: 7 });
      await expect(nextArtworkTry('c1', URI, 3, 0, probe)).resolves.toEqual({
        delay: 7_000,
        busy: true,
      });
      expect(probe).toHaveBeenCalledWith(URI);
    }
  });

  it("holds every row of that server until then, asking nothing; another server isn't held", async () => {
    await nextArtworkTry('c1', URI, 0, 0, answers({ status: 429, retryAfterSeconds: 10 }));
    const probe = answers(null);
    const next = await nextArtworkTry('c1', `${URI}2`, 0, 0, probe);
    expect(next?.busy).toBe(true);
    expect(next!.delay).toBeGreaterThan(9_000);
    expect(next!.delay).toBeLessThanOrEqual(10_000);
    expect(probe).not.toHaveBeenCalled();
    await expect(nextArtworkTry('c2', URI, 0, 0, probe)).resolves.toEqual({
      delay: 3_000,
      busy: false,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('sends one probe for a burst of failures while the server is busy', async () => {
    const probe = answers({ status: 429, retryAfterSeconds: 10 });
    const tries = await Promise.all(
      [1, 2, 3].map((n) => nextArtworkTry('c1', `${URI}${n}`, 0, 0, probe)),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(tries.every((next) => next?.busy)).toBe(true);
  });

  it('bounds the wait between 1 s and a minute', async () => {
    const at = async (retryAfterSeconds: number) => {
      resetArtworkBusy();
      return (await nextArtworkTry('c1', URI, 0, 0, answers({ status: 429, retryAfterSeconds })))
        ?.delay;
    };
    expect(await at(0)).toBe(1_000);
    expect(await at(3_600)).toBe(60_000);
  });

  it('stops at once for an artwork that is gone', async () => {
    for (const status of [400, 403, 404, 410]) {
      await expect(nextArtworkTry('c1', URI, 0, 0, answers({ status }))).resolves.toBeNull();
    }
  });

  it('falls back to 3 s, 10 s, 30 s, then stops, without a usable answer', async () => {
    for (const probe of [
      answers(null),
      answers({ status: 200 }),
      answers({ status: 500 }),
      // Busy without a header the page can read (cross-origin without the expose).
      answers({ status: 429 }),
    ]) {
      const delays = [];
      for (const quiet of [0, 1, 2, 3])
        delays.push((await nextArtworkTry('c1', URI, quiet, 0, probe))?.delay);
      expect(delays).toEqual([3_000, 10_000, 30_000, undefined]);
    }
  });

  it('stops honouring busy answers after the last busy wait', async () => {
    const probe = answers({ status: 429, retryAfterSeconds: 5 });
    await expect(nextArtworkTry('c1', URI, 0, ARTWORK_BUSY_MAX_WAITS, probe)).resolves.toEqual({
      delay: 3_000,
      busy: false,
    });
    await expect(nextArtworkTry('c1', URI, 3, ARTWORK_BUSY_MAX_WAITS, probe)).resolves.toBeNull();
  });
});

describe('probeArtwork', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('asks with HEAD and reads the status and Retry-After', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 429,
      headers: { get: (h: string) => (h === 'Retry-After' ? '4' : null) },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(probeArtwork(URI)).resolves.toEqual({ status: 429, retryAfterSeconds: 4 });
    expect(fetchMock).toHaveBeenCalledWith(URI, expect.objectContaining({ method: 'HEAD' }));
  });

  it('is null when nothing answers', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(probeArtwork(URI)).resolves.toBeNull();
  });
});
