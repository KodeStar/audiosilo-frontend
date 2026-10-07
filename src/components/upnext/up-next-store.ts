import { Dimensions } from 'react-native';
import { create } from 'zustand';

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
  /** The tablet/phone sheet. Never remembered: a sheet must not open itself at launch. */
  sheetOpen: boolean;
  setDrawerWidth: (width: number) => void;
  closeSheet: () => void;
};

/**
 * Up next's open state (the `upnext` components): the desktop drawer (open by default,
 * collapsible, 300-480 wide; both remembered on this device) and the tablet/phone sheet.
 * Open it from anywhere with `openUpNext()` / `toggleUpNext()`, which pick the drawer or
 * the sheet by the window's form factor at the time of the call.
 */
export const useUpNext = create<UpNextState>()((set, get) => ({
  ...BASE,
  sheetOpen: false,
  setDrawerWidth: (width) => {
    const drawerWidth = clampDrawerWidth(width);
    if (drawerWidth === get().drawerWidth) return;
    set({ drawerWidth });
    stored.write({ drawerWidth }, { drawerOpen: get().drawerOpen, drawerWidth });
  },
  closeSheet: () => set({ sheetOpen: false }),
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

/** Shows Up next: the drawer on a desktop, the sheet on a tablet or phone. */
export function openUpNext() {
  if (desktop()) setDrawer(true);
  else useUpNext.setState({ sheetOpen: true });
}

/** Hides Up next, whichever form it has. */
export function closeUpNext() {
  if (desktop()) setDrawer(false);
  else useUpNext.setState({ sheetOpen: false });
}

/** Shows or hides Up next (the Q key, the top bar and dock buttons). */
export function toggleUpNext() {
  const s = useUpNext.getState();
  if (desktop() ? s.drawerOpen : s.sheetOpen) closeUpNext();
  else openUpNext();
}
