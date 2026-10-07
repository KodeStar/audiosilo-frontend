import { PHONE_COVER_MIN, phoneCoverSize, playerCoverSize } from './player-view-model';

describe('phoneCoverSize', () => {
  it('is the width rule until both heights are measured', () => {
    expect(phoneCoverSize(400, 0, 0, 12)).toBe(playerCoverSize('phone', 400, 0));
    expect(phoneCoverSize(400, 800, 0, 12)).toBe(312);
  });

  it('keeps the width rule where the phone is tall enough', () => {
    expect(phoneCoverSize(390, 900, 420, 12)).toBe(304);
  });

  it('shrinks to what the viewport leaves under the rest, so nothing needs a scroll', () => {
    // 760 viewport - 470 rest - 12 padding - 36 around the cover.
    expect(phoneCoverSize(400, 760, 470, 12)).toBe(242);
  });

  it('never goes below the minimum (a very short window scrolls instead)', () => {
    expect(phoneCoverSize(375, 500, 470, 12)).toBe(PHONE_COVER_MIN);
  });
});
