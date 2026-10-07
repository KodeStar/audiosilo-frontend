import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The pieces of bottom chrome the shell lays out over or under the page: the phone tab
 * bar (`bar`: ours on web; the native bar's top edge from the tab stacks' layout), the
 * floating mini player card (`mini`), the iOS 26 tab bar accessory pill (`accessory`),
 * the docked player bar (`dock`), and the sleep timer's floating grace card (`grace`,
 * above all of them while it shows, so toasts clear it too).
 */
export type ChromePiece = 'bar' | 'mini' | 'accessory' | 'dock' | 'grace';

/**
 * What the shell measures for overlays that live outside it (the root `ShellToastHost`):
 * each laid-out piece's TOP edge, as its distance from the window's bottom edge. A piece
 * that is not showing has no entry.
 */
type ShellMetrics = {
  edges: Partial<Record<ChromePiece, number>>;
  /** Native: the shell frame's bottom edge, measured with `measureInWindow`, so the tab
   * stacks can measure the native bar against it in the SAME coordinates. Android's
   * `measureInWindow` is offset by the status bar under edge-to-edge while the window's
   * height is not, so comparing a page's measured bottom with the window height put the
   * bar a status bar too tall. The frame spans the window, so its bottom is the window's. */
  frameBottom?: number;
};

export const useShellMetrics = create<ShellMetrics>(() => ({ edges: {} }));

/** Records the shell frame's measured bottom edge (native; see `frameBottom`). */
export function setFrameBottom(bottom: number) {
  if (useShellMetrics.getState().frameBottom !== bottom) {
    useShellMetrics.setState({ frameBottom: bottom });
  }
}

/** Publishes one piece's top edge, or withdraws it (`undefined`). */
export function setChromeEdge(piece: ChromePiece, edge: number | undefined) {
  const { edges } = useShellMetrics.getState();
  if (edges[piece] === edge) return;
  const next = { ...edges };
  if (edge === undefined) delete next[piece];
  else next[piece] = edge;
  useShellMetrics.setState({ edges: next });
}

/** The native tab bar's top edge (its distance from the window's bottom) from a tab
 * page's measured bottom and the shell frame's, both from `measureInWindow`; never below
 * the page's bottom safe-area inset (iOS lays the page out under its bar, so the inset is
 * the bar there). Undefined until both have been measured. */
export function nativeBarEdge(
  insetBottom: number,
  frameBottom: number | undefined,
  pageBottom: number | undefined,
): number | undefined {
  if (frameBottom === undefined || pageBottom === undefined) return undefined;
  return Math.max(insetBottom, frameBottom - pageBottom);
}

/** The top edge of the bottom chrome (its highest piece), or undefined before any piece
 * has been laid out. `except` leaves one piece out (the grace card sits on the rest). */
export function bottomChromeTop(
  edges: ShellMetrics['edges'],
  except?: ChromePiece,
): number | undefined {
  const values = Object.entries(edges)
    .filter(([piece]) => piece !== except)
    .map(([, edge]) => edge);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** Keeps `piece` published at `edge` (undefined: not showing), and withdraws it when the
 * component unmounts. A caller that does not own the piece on this platform or in this
 * placement passes `owner: false` and touches nothing. */
export function useChromeEdge(piece: ChromePiece, edge: number | undefined, owner = true) {
  useEffect(() => {
    if (owner) setChromeEdge(piece, edge);
  }, [piece, edge, owner]);
  useEffect(() => {
    if (owner) return () => setChromeEdge(piece, undefined);
  }, [piece, owner]);
}
