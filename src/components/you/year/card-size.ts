/** The width a card is designed at: every size on it is in units of `width / 360`. */
export const CARD_DESIGN_WIDTH = 360;

/** A card's height for its width: 9:16. */
export function cardHeight(width: number): number {
  return Math.round((width * 16) / 9);
}
