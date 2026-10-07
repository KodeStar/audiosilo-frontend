import { clampCard, isHeld, isStill, stepCard } from './story-model';

describe('story rules', () => {
  it('keeps a card index inside the story', () => {
    expect(clampCard(5, 3)).toBe(2);
    expect(clampCard(-1, 3)).toBe(0);
    expect(clampCard(1.7, 3)).toBe(1);
    expect(clampCard(Number.NaN, 3)).toBe(0);
    expect(clampCard(2, 0)).toBe(0);
  });

  it('wraps next from the last card and stops previous at the first', () => {
    expect(stepCard(0, 1, 3)).toBe(1);
    expect(stepCard(2, 1, 3)).toBe(0);
    expect(stepCard(1, -1, 3)).toBe(0);
    expect(stepCard(0, -1, 3)).toBe(0);
    expect(stepCard(0, 1, 0)).toBe(0);
  });

  it('holds for a share, a screen reader or a hold, and stays still for reduced motion', () => {
    const none = { reducedMotion: false, screenReader: false, sharing: false, held: false };
    expect(isHeld(none)).toBe(false);
    expect(isHeld({ ...none, sharing: true })).toBe(true);
    expect(isHeld({ ...none, screenReader: true })).toBe(true);
    expect(isHeld({ ...none, held: true })).toBe(true);
    expect(isHeld({ ...none, reducedMotion: true })).toBe(false);
    expect(isStill({ reducedMotion: true })).toBe(true);
  });
});
