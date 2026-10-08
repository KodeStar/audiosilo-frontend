/**
 * The story cards' backgrounds (the Stacks prototype's `YearCards()` gradients), as data
 * that react-native-svg draws on every platform (`story-background.tsx`), so the card on
 * screen and the image it shares are the same drawing. Content colours, the same in both
 * themes: a card is a printed object, always white type on a deep ground. Each light
 * glow sits in a corner and fades out well before the middle, and the type keeps to the
 * deep ground (AA for the body copy; the glows sit behind the big numbers and headings).
 */

export type StoryTheme = 'dusk' | 'navy' | 'sky' | 'rose' | 'teal' | 'amber' | 'violet';

/** A radial glow in the card's box (0..1 units): centre, radii, where it fades out. */
export type RadialLayer = {
  kind: 'radial';
  color: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** 0..1 along the radius where the colour is gone. */
  fade: number;
  /** Strength at the centre. */
  opacity: number;
};

/** A linear wash across the card's box (0..1 units). */
export type LinearLayer = {
  kind: 'linear';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: readonly (readonly [offset: number, color: string])[];
};

export type StoryBackdrop = { base: string; layers: readonly (RadialLayer | LinearLayer)[] };

const radial = (
  color: string,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fade: number,
  opacity = 0.9,
): RadialLayer => ({ kind: 'radial', color, cx, cy, rx, ry, fade, opacity });

export const STORY_THEMES: Record<StoryTheme, StoryBackdrop> = {
  // radial-gradient(120% 80% at 0% 0%, #ff4f9a, transparent 60%),
  // radial-gradient(100% 90% at 100% 100%, #3b2bd6, transparent 60%), #160b2e
  dusk: {
    base: '#160b2e',
    layers: [radial('#ff4f9a', 0, 0, 1.2, 0.8, 0.6, 0.8), radial('#3b2bd6', 1, 1, 1, 0.9, 0.6)],
  },
  // linear-gradient(180deg, #0d1b3d, #1a2a6c)
  navy: {
    base: '#0d1b3d',
    layers: [
      {
        kind: 'linear',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 1,
        stops: [
          [0, '#0d1b3d'],
          [1, '#1a2a6c'],
        ],
      },
    ],
  },
  // radial-gradient(100% 70% at 50% 0%, #5b8cff, transparent 70%), #0d1b3d
  sky: { base: '#0d1b3d', layers: [radial('#5b8cff', 0.5, 0, 1, 0.7, 0.7, 0.75)] },
  // radial-gradient(90% 70% at 100% 0%, #e8649f, transparent 70%), #2a0d22
  rose: { base: '#2a0d22', layers: [radial('#e8649f', 1, 0, 0.9, 0.7, 0.7, 0.75)] },
  // linear-gradient(160deg, #0f2a3a, #123b4a 60%, #1a2340)
  teal: {
    base: '#0f2a3a',
    layers: [
      {
        kind: 'linear',
        x1: 0.33,
        y1: 0.03,
        x2: 0.67,
        y2: 0.97,
        stops: [
          [0, '#0f2a3a'],
          [0.6, '#123b4a'],
          [1, '#1a2340'],
        ],
      },
    ],
  },
  // radial-gradient(100% 70% at 0% 100%, #f0b04d, transparent 70%), #2b1608
  amber: { base: '#2b1608', layers: [radial('#f0b04d', 0, 1, 1, 0.7, 0.7, 0.55)] },
  // radial-gradient(90% 70% at 50% 0%, #7c3aed, transparent 70%), #140b2b
  violet: { base: '#140b2b', layers: [radial('#7c3aed', 0.5, 0, 0.9, 0.7, 0.7, 0.8)] },
};
