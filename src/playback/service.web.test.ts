import { isSwapReady } from './service.web';

// HTMLMediaElement.readyState levels (numeric so the test reads like the browser).
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

describe('isSwapReady', () => {
  it('is ready when it can play through AND the playhead is at the seek target', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 30, 30)).toBe(true);
    expect(isSwapReady(HAVE_ENOUGH_DATA, 30.4, 30)).toBe(true); // within ~1.5s tolerance
  });

  it('is not ready until it can play through', () => {
    expect(isSwapReady(HAVE_CURRENT_DATA, 30, 30)).toBe(false);
    expect(isSwapReady(0, 30, 30)).toBe(false);
  });

  it('is not ready until the playhead reaches the target', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 0, 30)).toBe(false); // seek not applied yet
    expect(isSwapReady(HAVE_FUTURE_DATA, 28, 30)).toBe(false); // 2s off > tolerance
  });

  it('treats a falsy target as the start of the track', () => {
    expect(isSwapReady(HAVE_FUTURE_DATA, 0.5, 0)).toBe(true);
    expect(isSwapReady(HAVE_FUTURE_DATA, 2, 0)).toBe(false);
  });
});
