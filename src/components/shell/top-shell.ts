import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** The mounted app shells, oldest first (the root stack's order). */
const useShells = create<{ ids: number[] }>(() => ({ ids: [] }));
let lastId = 0;

/**
 * Whether this app shell (`(app)` layout) is the top one. Normally there is exactly one
 * (pages from over the full player open in it: `pushInShell`), but a stray push or
 * replace from a root route can stack a second `(app)` over the first, and the shell's
 * singletons - the player's sheet host, the command palette, the shortcuts overlay and the
 * global keyboard shortcuts - must then live in the top one only: two would render every
 * dialog twice (two scrims, two focus scopes) and run every key twice (Q toggling Up next
 * open and shut again). A shell pushed later mounts later, so the top is the newest.
 * False until mounted.
 */
export function useIsTopShell(): boolean {
  const [id] = useState(() => ++lastId);
  useEffect(() => {
    useShells.setState((s) => ({ ids: [...s.ids, id] }));
    return () => useShells.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  return useShells((s) => s.ids[s.ids.length - 1] === id);
}
