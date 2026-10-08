import { clampCard, stepCard } from './story-model';

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
});
