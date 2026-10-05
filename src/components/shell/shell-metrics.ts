import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The pieces of bottom chrome the shell lays out over or under the page: the phone tab
 * bar (`bar`: ours on web; the native bar's top edge from the tab stacks' layout), the
 * floating mini player card (`mini`), the iOS 26 tab bar accessory pill (`accessory`),
 * and the docked player bar (`dock`).
 */
export type ChromePiece = 'bar' | 'mini' | 'accessory' | 'dock';

/**
 * What the shell measures for overlays that live outside it (the root `ShellToastHost`):
 * each laid-out piece's TOP edge, as its distance from the window's bottom edge. A piece
 * that is not showing has no entry.
 */
type ShellMetrics = { edges: Partial<Record<ChromePiece, number>> };

export const useShellMetrics = create<ShellMetrics>(() => ({ edges: {} }));

/** Publishes one piece's top edge, or withdraws it (`undefined`). */
export function setChromeEdge(piece: ChromePiece, edge: number | undefined) {
  const { edges } = useShellMetrics.getState();
  if (edges[piece] === edge) return;
  const next = { ...edges };
  if (edge === undefined) delete next[piece];
  else next[piece] = edge;
  useShellMetrics.setState({ edges: next });
}

/** The top edge of the bottom chrome (its highest piece), or undefined before any piece
 * has been laid out. */
export function bottomChromeTop(edges: ShellMetrics['edges']): number | undefined {
  const values = Object.values(edges);
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
