import { useEffect } from 'react';
import { create } from 'zustand';

import { contentKey } from '@/lib/content-key';
import { persistedDocument } from '@/lib/storage';
import { onForeground } from '@/lib/when-active';
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

/**
 * `seconds` as precise as `formatDuration` shows it: whole seconds under a minute, whole
 * minutes from there. The hooks select this, so a screen showing the figure re-renders
 * when the words would change, not on every silence the engine trims.
 */
export function savedForDisplay(seconds: number): number {
  const whole = Math.round(seconds);
  return whole < 60 ? whole : whole - (whole % 60);
}

const stored = persistedDocument<TimeSavedDoc>('audiosilo.timeSaved', parseTimeSaved);

/** The counts as the UI shows them: the stored ones plus what this run added. */
export const useTimeSavedStore = create<TimeSavedDoc>()(() => EMPTY);

/** The engine total the next one is measured from (`silenceDelta`). */
let base: number | null = null;
/** Counts added since the last write. */
let dirty = false;
/** Something was counted this run: the stored counts are being read and the app's
 * leaving the foreground flushes. */
let counting = false;

const docOf = (s: TimeSavedDoc): TimeSavedDoc => ({ lifetime: s.lifetime, books: s.books });

/** Read the stored counts once (later calls share the first read). What was counted
 * before it finished is added on top, never overwritten. */
export function hydrateTimeSaved(): Promise<void> {
  return stored.hydrate(EMPTY, (doc) => {
    useTimeSavedStore.setState(mergeSaved(doc, docOf(useTimeSavedStore.getState())));
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
  flushLoop.start();
  if (!counting) {
    counting = true;
    void hydrateTimeSaved();
    // Leaving the foreground may be the last chance: the OS can end the process there.
    // For the process's life, like the counts themselves.
    onForeground(
      () => {},
      () => void flushTimeSaved(),
    );
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

/** Seconds Smart Speed saved on this device, in all (0 before any), as precise as it is
 * shown (`savedForDisplay`). */
export function useTimeSaved(): number {
  useEffect(() => void hydrateTimeSaved(), []);
  return useTimeSavedStore((s) => savedForDisplay(s.lifetime));
}

/** Seconds Smart Speed saved on one book on this device (0 before any, or without a
 * book), as precise as it is shown (`savedForDisplay`). */
export function useBookTimeSaved(
  connectionId: string | null | undefined,
  libraryId: number,
  path: string | null | undefined,
): number {
  useEffect(() => void hydrateTimeSaved(), []);
  return useTimeSavedStore((s) =>
    connectionId && path
      ? savedForDisplay(s.books[contentKey(connectionId, libraryId, path)] ?? 0)
      : 0,
  );
}
