import { CAST_TOKEN_MARGIN_MS, createCastTokenCache } from './cast-token';

const HOUR = 60 * 60_000;

function source(expiresInMs: number, now: () => number) {
  let n = 0;
  const castToken = jest.fn(async () => {
    n++;
    return { token: `tok${n}`, expires_at: new Date(now() + expiresInMs).toISOString() };
  });
  return { castToken };
}

describe('cast token cache', () => {
  let clock = Date.parse('2026-10-09T12:00:00.000Z');
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse('2026-10-09T12:00:00.000Z');
  });

  it('mints once per book and reuses it until an hour before it expires', async () => {
    const cache = createCastTokenCache(now);
    const src = source(24 * HOUR, now);
    expect(await cache.get(src, 'srv.1', 1, 'A/B')).toBe('tok1');
    clock += 22 * HOUR;
    expect(await cache.get(src, 'srv.1', 1, 'A/B')).toBe('tok1');
    expect(src.castToken).toHaveBeenCalledTimes(1);
    clock += HOUR; // 1 h left: no longer enough
    expect(await cache.get(src, 'srv.1', 1, 'A/B')).toBe('tok2');
    expect(src.castToken).toHaveBeenCalledTimes(2);
    expect(CAST_TOKEN_MARGIN_MS).toBe(HOUR);
  });

  it('keys on the connection and the book (path is identity, scoped by connection)', async () => {
    const cache = createCastTokenCache(now);
    const src = source(24 * HOUR, now);
    await cache.get(src, 'srv.1', 1, 'A/B');
    await cache.get(src, 'srv.2', 1, 'A/B');
    await cache.get(src, 'srv.1', 1, 'A/C');
    expect(src.castToken).toHaveBeenCalledTimes(3);
    expect(src.castToken).toHaveBeenLastCalledWith(1, 'A/C');
  });

  it('shares one request between concurrent asks', async () => {
    const cache = createCastTokenCache(now);
    const src = source(24 * HOUR, now);
    const [a, b] = await Promise.all([
      cache.get(src, 'srv.1', 1, 'A/B'),
      cache.get(src, 'srv.1', 1, 'A/B'),
    ]);
    expect(a).toBe('tok1');
    expect(b).toBe('tok1');
    expect(src.castToken).toHaveBeenCalledTimes(1);
  });

  it('rejects when the server refuses, and asks again next time', async () => {
    const cache = createCastTokenCache(now);
    const castToken = jest
      .fn()
      .mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce({ token: 'ok', expires_at: '2026-10-10T12:00:00.000Z' });
    await expect(cache.get({ castToken }, 'srv.1', 1, 'A/B')).rejects.toThrow('403');
    expect(await cache.get({ castToken }, 'srv.1', 1, 'A/B')).toBe('ok');
  });

  it('uses a token whose expiry it cannot read for that load only', async () => {
    const cache = createCastTokenCache(now);
    const castToken = jest.fn(async () => ({ token: 'x', expires_at: 'garbage' }));
    await cache.get({ castToken }, 'srv.1', 1, 'A/B');
    await cache.get({ castToken }, 'srv.1', 1, 'A/B');
    expect(castToken).toHaveBeenCalledTimes(2);
  });

  it("forgets a removed connection's tokens only", async () => {
    const cache = createCastTokenCache(now);
    const src = source(24 * HOUR, now);
    await cache.get(src, 'srv.1', 1, 'A/B');
    await cache.get(src, 'srv.10', 1, 'A/B');
    cache.clear('srv.1');
    await cache.get(src, 'srv.1', 1, 'A/B'); // minted again
    await cache.get(src, 'srv.10', 1, 'A/B'); // still cached (a prefix, not a match)
    expect(src.castToken).toHaveBeenCalledTimes(3);
  });
});
