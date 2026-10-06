import { type ReactNode, useEffect } from 'react';
import { create } from 'zustand';

import type { SegmentedOption } from '@/components/ui/toggle-group';

import type { TabName } from './destinations';

/** A tab root's sections: the segmented control in the sub-nav (STYLEGUIDE section 2:
 * "Title [segmented control of sections] [contextual actions]"). */
export type SubNavSectionsSpec = {
  options: SegmentedOption<string>[];
  value: string;
  onChange: (value: string) => void;
  /** What the sections choose between ("Browse by"). */
  accessibilityLabel: string;
};

type SubNavAction = { id: string; order: number; node: ReactNode };

type Slot = { sections?: SubNavSectionsSpec; actions: SubNavAction[] };

type SubNavState = {
  /** What each tab ROOT has published (a tab's pushed pages publish nothing). */
  slots: Partial<Record<TabName, Slot>>;
  setSections: (tab: TabName, sections: SubNavSectionsSpec | undefined) => void;
  setAction: (tab: TabName, id: string, action: Omit<SubNavAction, 'id'> | undefined) => void;
};

const slotOf = (s: SubNavState, tab: TabName): Slot => s.slots[tab] ?? { actions: [] };

/**
 * What the tab roots put in the tablet/desktop sub-nav row, keyed by tab (NativeTabs
 * keeps every visited tab mounted, so each root publishes under its own tab and the
 * sub-nav shows the active one's). Write through `SubNavSections` / `SubNavActions`
 * (`tab-root-nav.tsx`); read with `useSubNavSlot`.
 */
export const useSubNav = create<SubNavState>()((set) => ({
  slots: {},
  setSections: (tab, sections) =>
    set((s) => ({ slots: { ...s.slots, [tab]: { ...slotOf(s, tab), sections } } })),
  setAction: (tab, id, action) =>
    set((s) => {
      const slot = slotOf(s, tab);
      const others = slot.actions.filter((a) => a.id !== id);
      const actions = action
        ? [...others, { id, ...action }].sort((a, b) => a.order - b.order)
        : others;
      return { slots: { ...s.slots, [tab]: { ...slot, actions } } };
    }),
}));

/** The published sections and actions of a tab root. */
export function useSubNavSlot(tab: TabName | null): Slot | undefined {
  return useSubNav((s) => (tab ? s.slots[tab] : undefined));
}

/**
 * Publish `value` into a tab's slot while `enabled`: refreshed after every render of
 * the publisher (its closures and node stay current), withdrawn when it unmounts or is
 * disabled. The publisher never reads the store, so a refresh can't loop.
 */
export function usePublish<T>(
  enabled: boolean,
  value: T,
  put: (value: T | undefined) => void,
  key: string,
) {
  useEffect(() => {
    if (enabled) put(value);
  });
  useEffect(() => {
    if (!enabled) return;
    return () => put(undefined);
    // `put` is keyed by tab and id (`key`): a new key withdraws the old entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
}
