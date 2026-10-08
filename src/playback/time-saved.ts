import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { contentKey } from '@/lib/content-key';
import { persistedDocument } from '@/lib/storage';
import { onConnectionRemoved } from '@/stores/session';

import { engineTicker } from './engine-ticks';

/**
 * "Time saved" (contract decision 8): book seconds Smart Speed removed, per book and in
 * all, kept on this device only (no wire change). Speed is not counted: the figure is
 * what the silences would have taken at 1x.
 *
 * The engine reports a running total (`onSilenceSaved`: monotonic while one engine lives,
 * back to 0 for a new one); the store hands each total here with the playing book's
 * `contentKey`. Saved with `persistedDocument`, but never a write per tick: the totals
 * are flushed on a pause (the store's halt), when the app leaves the foreground, and
 * every 30 s while they grow (an `engineTicker`, so Android's paused JS timers can't
 * stop it).
 */

/** What is stored: the lifetime total and each book's, in seconds. */
export type TimeSavedDoc = { lifetime: number; books: Record<string, number> };

const EMPTY: TimeSavedDoc = { lifetime: 0, books: {} };
const FLUSH_MS = 30_000;

/**
 * The seconds a new engine total adds, and the base the next one is measured from. The
 * first total this JS has seen is only a base (an engine can outlive the JS, the Android
 * service does, and its total then holds savings already counted); so is a total LOWER
 * than the base (a new engine, which starts again at 0). Anything not a finite,
 * non-negative number changes nothing.
 */
export function silenceDelta(
  base: number | null,
  total: number,
): { delta: number; base: number | null } {
  if (!Number.isFinite(total) || total < 0) return { delta: 0, base };
  if (base === null || total < base) return { delta: 0, base: total };
  return { delta: total - base, base: total };
}

/** `doc` with `seconds` more saved, in all and on `bookKey`'s count. */
export function addSaved(doc: TimeSavedDoc, bookKey: string, seconds: number): TimeSavedDoc {
  if (!(seconds > 0)) return doc;
  return {
    lifetime: doc.lifetime + seconds,
    books: { ...doc.books, [bookKey]: (doc.books[bookKey] ?? 0) + seconds },
  };
}

/** Two documents' counts summed (stored + counted before the stored one was read). */
export function mergeSaved(a: TimeSavedDoc, b: TimeSavedDoc): TimeSavedDoc {
  const books = { ...a.books };
  for (const [k, v] of Object.entries(b.books)) books[k] = (books[k] ?? 0) + v;
  return { lifetime: a.lifetime + b.lifetime, books };
}

/** `doc` without the books of the connection `connectionId` (their keys are
 * `contentKey`s, which start with it). The lifetime total stays: it is this device's. */
export function withoutConnection(doc: TimeSavedDoc, connectionId: string): TimeSavedDoc {
  const prefix = `${connectionId}:`;
  const books = Object.fromEntries(
    Object.entries(doc.books).filter(([k]) => !k.startsWith(prefix)),
  );
  return { lifetime: doc.lifetime, books };
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/** A stored value read back: anything that isn't a count is dropped. */
export function parseTimeSaved(raw: unknown): Partial<TimeSavedDoc> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const { lifetime, books } = raw as Record<string, unknown>;
  const parsed: Record<string, number> = {};
  if (books && typeof books === 'object' && !Array.isArray(books)) {
    for (const [k, v] of Object.entries(books)) if (count(v) > 0) parsed[k] = count(v);
  }
  return { lifetime: count(lifetime), books: parsed };
}

const stored = persistedDocument<TimeSavedDoc>('audiosilo.timeSaved', parseTimeSaved);

type TimeSavedState = TimeSavedDoc & {
  /** The stored document has been read (and merged into what was counted before). */
  hydrated: boolean;
};

/** The counts as the UI shows them: the stored ones plus what this run added. */
export const useTimeSavedStore = create<TimeSavedState>()(() => ({ ...EMPTY, hydrated: false }));

/** The engine total the next one is measured from (`silenceDelta`). */
let base: number | null = null;
/** Counts added since the last write. */
let dirty = false;
let appStateWatched = false;

const docOf = (s: TimeSavedState): TimeSavedDoc => ({ lifetime: s.lifetime, books: s.books });

/** Read the stored counts once (later calls share the first read). What was counted
 * before it finished is added on top, never overwritten. */
export function hydrateTimeSaved(): Promise<void> {
  return stored.hydrate(EMPTY, (doc) => {
    const counted = docOf(useTimeSavedStore.getState());
    useTimeSavedStore.setState({ ...mergeSaved(doc, counted), hydrated: true });
  });
}

/** Write the counts if any were added since the last write. Waits for the stored ones
 * first: writing before them would replace them. */
export async function flushTimeSaved(): Promise<void> {
  if (!dirty) return;
  await hydrateTimeSaved();
  if (!dirty) return; // another flush wrote them meanwhile
  dirty = false;
  flushLoop.stop();
  const doc = docOf(useTimeSavedStore.getState());
  stored.write(doc, doc);
}

const flushLoop = engineTicker(() => void flushTimeSaved(), FLUSH_MS);

/**
 * The engine's running total (`totalSeconds`) while `bookKey` (the playing book's
 * `contentKey`, null when none) is loaded. Positive growth is counted on that book and in
 * all; see `silenceDelta` for what counts as growth.
 */
export function noteSilenceSaved(totalSeconds: number, bookKey: string | null): void {
  const next = silenceDelta(base, totalSeconds);
  base = next.base;
  if (next.delta <= 0 || !bookKey) return;
  useTimeSavedStore.setState((s) => addSaved(docOf(s), bookKey, next.delta));
  dirty = true;
  void hydrateTimeSaved();
  flushLoop.start();
  if (!appStateWatched) {
    appStateWatched = true;
    // Leaving the foreground may be the last chance: the OS can end the process there.
    AppState.addEventListener('change', (state) => {
      if (state !== 'active') void flushTimeSaved();
    });
  }
}

/** Forget the engine base (tests; a fresh engine would also re-base by itself). */
export function resetTimeSavedBase(): void {
  base = null;
}

// A removed connection's books go with it (re-adding a server mints a new id).
onConnectionRemoved(async (id) => {
  await hydrateTimeSaved();
  const doc = docOf(useTimeSavedStore.getState());
  const next = withoutConnection(doc, id);
  if (Object.keys(next.books).length === Object.keys(doc.books).length) return;
  useTimeSavedStore.setState(next);
  stored.write(next, next);
});

/** Seconds Smart Speed saved on this device, in all (0 before any). */
export function useTimeSaved(): number {
  useEffect(() => void hydrateTimeSaved(), []);
  return useTimeSavedStore((s) => s.lifetime);
}

/** Seconds Smart Speed saved on one book on this device (0 before any, or without a
 * book). */
export function useBookTimeSaved(
  connectionId: string | null | undefined,
  libraryId: number,
  path: string | null | undefined,
): number {
  useEffect(() => void hydrateTimeSaved(), []);
  return useTimeSavedStore((s) =>
    connectionId && path ? (s.books[contentKey(connectionId, libraryId, path)] ?? 0) : 0,
  );
}
