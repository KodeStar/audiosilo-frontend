import { useEffect } from 'react';
import { create } from 'zustand';

import { persistedDocument } from '@/lib/storage';

/** How a list of books is laid out: cover grid or rows. */
export type BooksLayout = 'grid' | 'list';

type Doc = { layout: BooksLayout };

const parse = (raw: unknown): Partial<Doc> => {
  const layout = (raw as Partial<Doc> | null)?.layout;
  return layout === 'grid' || layout === 'list' ? { layout } : {};
};

// A device preference, not per-server state (so neither storage-reset axis wipes it).
const stored = persistedDocument<Doc>('audiosilo.booksLayout', parse);

const useStore = create<Doc & { setLayout: (layout: BooksLayout) => void }>()((set) => ({
  layout: 'grid',
  setLayout: (layout) => {
    set({ layout });
    stored.write({ layout }, { layout });
  },
}));

let hydration: Promise<void> | null = null;

/**
 * The grid/list choice for book lists (Library Books, a collection, Favourites),
 * remembered on this device. Hydrated on first use rather than at boot: until then
 * the default (grid) shows, and a choice made meanwhile wins (`persistedDocument`).
 */
export function useBooksLayout(): [BooksLayout, (layout: BooksLayout) => void] {
  useEffect(() => {
    hydration ??= stored.hydrate({ layout: 'grid' }, (doc) => useStore.setState(doc));
  }, []);
  return [useStore((s) => s.layout), useStore((s) => s.setLayout)];
}
