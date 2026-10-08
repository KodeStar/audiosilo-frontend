/**
 * html-to-image, loaded on first use: the web build splits it into its own chunk, so the
 * player's main bundle doesn't carry a DOM rasteriser nobody uses until they share a
 * card. Only the web's `share-card.web.ts` imports this.
 */
export async function loadRasteriser() {
  return import('html-to-image');
}
