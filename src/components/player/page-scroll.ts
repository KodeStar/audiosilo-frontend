import { createContext, useContext, useState } from 'react';
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ViewInstance,
} from 'react-native';

/** Where the player's page scroller is. */
export type PageScrollState = {
  /** How far the page is scrolled. */
  y: number;
  /** The page's visible height (0 until it is laid out). */
  height: number;
  /** Counts the page's relayouts and content size changes: a child placed against `origin`
   * measures itself again when this moves, since a view that only moved with an ancestor
   * (content above it grew) gets no layout event of its own. */
  layout: number;
};

/**
 * The player's scrolling page, for a long list inline in it that draws only the rows near
 * the visible part (the tablet's Chapters tab, `ChaptersPanel`): a list nested in the page
 * can't be its own virtual list (the page scrolls it, so it never knows its viewport).
 */
export type PageScroll = {
  get(): PageScrollState;
  /** Called on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** A zero-size view at the top of the page's content (`setOrigin`): a child's offset in
   * the page is its `measureInWindow` y less this one's. */
  origin(): ViewInstance | null;
};

export const PageScrollContext = createContext<PageScroll | null>(null);

/** The page an inline list scrolls with, or null outside one. */
export function usePageScroll(): PageScroll | null {
  return useContext(PageScrollContext);
}

/** A page scroll source, the props its ScrollView spreads to feed it and its origin's ref. */
export function createPageScroll() {
  let state: PageScrollState = { y: 0, height: 0, layout: 0 };
  const listeners = new Set<() => void>();
  let origin: ViewInstance | null = null;
  const set = (next: Partial<PageScrollState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const scroll: PageScroll = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    origin: () => origin,
  };
  /** The origin view's ref (a callback ref). A new origin is a new page (the tablet's mounted
   * again after the desktop's, which has a scroller of its own): it starts at its top, so the
   * last page's offset is dropped, or its list would draw the rows far below what shows. */
  const setOrigin = (view: ViewInstance | null) => {
    const fresh = view !== null && view !== origin;
    origin = view;
    if (fresh && state.y !== 0) set({ y: 0 });
  };
  const props = {
    scrollEventThrottle: 16,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y;
      if (y !== state.y) set({ y });
    },
    onLayout: (e: LayoutChangeEvent) =>
      set({ height: e.nativeEvent.layout.height, layout: state.layout + 1 }),
    onContentSizeChange: () => set({ layout: state.layout + 1 }),
  };
  return { scroll, props, setOrigin };
}

/** `createPageScroll`, once per mount. */
export function usePageScrollSource() {
  const [source] = useState(createPageScroll);
  return source;
}
