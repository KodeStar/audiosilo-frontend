import {
  FELL_ASLEEP_LABEL,
  isBookmarkLabel,
  PICKABLE_BOOKMARK_LABELS,
} from '@/api/bookmark-labels';

describe('bookmark labels', () => {
  it('offers the five listener labels in picker order, never fell_asleep', () => {
    expect(PICKABLE_BOOKMARK_LABELS).toEqual([
      'quote',
      'favourite',
      'relisten',
      'funny',
      'question',
    ]);
    expect(PICKABLE_BOOKMARK_LABELS).not.toContain(FELL_ASLEEP_LABEL);
    expect(FELL_ASLEEP_LABEL).toBe('fell_asleep');
  });

  it('knows the six keys, and nothing else (no label, a newer client key)', () => {
    for (const key of [...PICKABLE_BOOKMARK_LABELS, FELL_ASLEEP_LABEL]) {
      expect(isBookmarkLabel(key)).toBe(true);
    }
    expect(isBookmarkLabel('')).toBe(false);
    expect(isBookmarkLabel(undefined)).toBe(false);
    expect(isBookmarkLabel('plot_twist')).toBe(false);
    expect(isBookmarkLabel('Quote')).toBe(false);
  });
});
