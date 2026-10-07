import { Dimensions } from 'react-native';
import { create } from 'zustand';

import { usePlayerSheets } from '@/components/player/player-sheets';
import { layoutFor } from '@/lib/layout';
import { persistedDocument } from '@/lib/storage';

import { clampDrawerWidth, DRAWER_DEFAULT } from './up-next-model';

/** What this device remembers about the desktop drawer. */
type Doc = { drawerOpen: boolean; drawerWidth: number };

function parseDoc(raw: unknown): Partial<Doc> {
  if (!raw || typeof raw !== 'object') return {};
  const { drawerOpen, drawerWidth } = raw as Record<string, unknown>;
  return {
    ...(typeof drawerOpen === 'boolean' ? { drawerOpen } : {}),
    ...(drawerWidth !== undefined ? { drawerWidth: clampDrawerWidth(drawerWidth) } : {}),
  };
}

// Device-local and not per server: how wide the listener likes the drawer.
const stored = persistedDocument<Doc>('audiosilo.upNext', parseDoc);
const BASE: Doc = { drawerOpen: true, drawerWidth: DRAWER_DEFAULT };

type UpNextState = Doc & {
  setDrawerWidth: (width: number) => void;
};

/**
 * Up next's desktop drawer (open by default, collapsible, 300-480 wide; both remembered
 * on this device). On a tablet or phone Up next is one of the player's sheets
 * (`usePlayerSheets`' `upnext`, never remembered: a sheet must not open itself at
 * launch). Open it from anywhere with `openUpNext()` / `toggleUpNext()`, which pick the
 * drawer or the sheet by the window's form factor at the time of the call.
 */
export const useUpNext = create<UpNextState>()((set, get) => ({
  ...BASE,
  setDrawerWidth: (width) => {
    const drawerWidth = clampDrawerWidth(width);
    if (drawerWidth === get().drawerWidth) return;
    set({ drawerWidth });
    stored.write({ drawerWidth }, { drawerOpen: get().drawerOpen, drawerWidth });
  },
}));

/** Reads the remembered drawer once (the drawer calls it when it first mounts). */
export function hydrateUpNext(): Promise<void> {
  return stored.hydrate(BASE, (doc) => useUpNext.setState(doc));
}

const desktop = () => layoutFor(Dimensions.get('window').width) === 'desktop';

function setDrawer(drawerOpen: boolean) {
  const { drawerWidth } = useUpNext.getState();
  useUpNext.setState({ drawerOpen });
  stored.write({ drawerOpen }, { drawerOpen, drawerWidth });
}

const sheetOpen = () => usePlayerSheets.getState().open === 'upnext';

/** Shows Up next: the drawer on a desktop, the sheet on a tablet or phone. */
export function openUpNext() {
  if (desktop()) setDrawer(true);
  else usePlayerSheets.getState().openSheet('upnext');
}

/** Hides Up next, whichever form it has. */
export function closeUpNext() {
  if (desktop()) setDrawer(false);
  else if (sheetOpen()) usePlayerSheets.getState().close();
}

/** Shows or hides Up next (the Q key, the top bar and dock buttons). */
export function toggleUpNext() {
  if (desktop() ? useUpNext.getState().drawerOpen : sheetOpen()) closeUpNext();
  else openUpNext();
}
