import { ApiError } from '@/api/client';
import type { OpmlImportResult, OpmlImportRow, PodcastRequest } from '@/api/types';
import { FOLLOW_REQUEST_POLL_MS, isOpenRequest } from '@/lib/podcast-requests';

/**
 * An OPML import in automatic waves (Bridge Phase 2d-2). One upload creates at most five
 * new follow requests and a listener can never have more than five open, so a long list
 * answers `limited` past them; uploading the same bytes again is the retry (the server
 * keeps nothing). The controller is framework-free (its timers, its dependencies
 * injected) so the rules are tested with fake timers; `useOpmlImport` wraps it for the
 * Find shows page, which keeps the bytes for its own life only.
 *
 * The rules:
 * - Upload, then merge the rows by `outline_index` (the latest answer wins). No `limited`
 *   row: `done`. `unavailable` rows (no online Bridge, a library it can't write, the
 *   module off) need a person, never another wave.
 * - Otherwise wait until every request this import queued is no longer open in the
 *   caller's follow requests (absent counts as ended; polled every 5 s), fewer than five
 *   of the caller's requests are open, and 30 s have passed since the last upload; then
 *   upload again. Nothing is polled once nothing it waits on is open.
 * - A wave that moves no row out of `limited` stops as `stalled` (the person can Try
 *   again).
 * - `429 opml_rate_limited` / `503 opml_busy` wait their `Retry-After` (else 30 s / 2 s);
 *   five such answers in a row stop it (`stopped`, `busy`). Any other refusal is `failed`
 *   with its code; a network failure or a timeout is `failed` with none (re-uploading is
 *   safe: rows already done answer `already_following` / `already_queued`).
 * - `pause()` (the app went to the background) holds every timer; `resume()` looks again
 *   at once. `mayAct()` (the person listening may act for this connection) is checked
 *   before each upload. `stop()` and `dispose()` send nothing more.
 */

/** The least time between two uploads (the server's import budget is 2 a minute). */
export const WAVE_SPACING_MS = 30_000;
/** The most follow requests a listener can have open at once. */
const OPEN_REQUEST_CAP = 5;
/** Busy answers in a row (429 / 503) after which the import stops. */
const BUSY_STOP_AFTER = 5;
/** The waits when a busy answer's `Retry-After` can't be read (cross-origin dev). */
const RATE_LIMITED_FALLBACK_S = 30;
const BUSY_FALLBACK_S = 2;

/** What the import is doing. `at` is when the next upload is due (epoch ms). */
export type WaveStatus =
  | { kind: 'uploading' }
  | { kind: 'waitingRequests' }
  | { kind: 'waitingTime'; at: number; why: 'spacing' | 'busy' }
  | { kind: 'done' }
  | { kind: 'stalled' }
  | { kind: 'stopped'; why: 'user' | 'busy' | 'cantAct' }
  | { kind: 'failed'; code: string | null };

export type WaveState = {
  status: WaveStatus;
  /** Every subscription the server answered for, by `outline_index`. */
  rows: OpmlImportRow[];
};

export type WaveDeps = {
  /** Upload the list's bytes once. */
  upload: (signal: AbortSignal) => Promise<OpmlImportResult>;
  /** The caller's follow requests now (`GET /me/podcasts`). */
  listRequests: () => Promise<readonly PodcastRequest[]>;
  /** Whether the person listening may still act for this connection. */
  mayAct: () => boolean;
  /** Every change of the state. */
  onChange: (state: WaveState) => void;
  /** Each answered upload (the caller reads its show list again). */
  onWave?: (result: OpmlImportResult) => void;
  now?: () => number;
};

const RUNNING: ReadonlySet<WaveStatus['kind']> = new Set([
  'uploading',
  'waitingRequests',
  'waitingTime',
]);

/** Whether the import is still going (uploading or waiting on its next wave). */
export const isRunning = (status: WaveStatus) => RUNNING.has(status.kind);

/** Whether Try again applies: it stopped, stalled or failed (a done import has nothing
 * left to send). */
const canRetry = (status: WaveStatus) => !isRunning(status) && status.kind !== 'done';

/** Whether Try again applies to an import: as `canRetry`, or done with rows that could
 * not be added right now (they need a person, so no automatic wave asks again). */
export const canRetryImport = ({ status, rows }: WaveState) =>
  canRetry(status) || (status.kind === 'done' && rows.some((r) => r.status === 'unavailable'));

/** The rows of `before` with `next`'s answers over them, by `outline_index`. */
export function mergeRows(
  before: readonly OpmlImportRow[],
  next: readonly OpmlImportRow[],
): OpmlImportRow[] {
  const byIndex = new Map(before.map((r) => [r.outline_index, r]));
  for (const r of next) byIndex.set(r.outline_index, r);
  return [...byIndex.values()].sort((a, b) => a.outline_index - b.outline_index);
}

const limitedOf = (rows: readonly OpmlImportRow[]) =>
  new Set(rows.filter((r) => r.status === 'limited').map((r) => r.outline_index));

export class OpmlWaves {
  private state: WaveState = { status: { kind: 'uploading' }, rows: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  /** Bumped by every stop, retry and dispose: a step of an older run lands nowhere. */
  private run = 0;
  private disposed = false;
  private paused = false;
  /** A look was due while paused: `resume` takes it at once. */
  private due = false;
  private busyStreak = 0;
  /** No upload before this (epoch ms). */
  private notBefore = 0;

  constructor(private readonly deps: WaveDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Upload the list (the first wave). */
  start() {
    void this.upload(++this.run);
  }

  /** Try again after it stopped, stalled or failed, or ended with rows that could not be
   * added right now: upload now. */
  retry() {
    if (this.disposed || !canRetryImport(this.state)) return;
    this.cancel();
    this.busyStreak = 0;
    void this.upload(++this.run);
  }

  /** Stop: nothing more is sent; the rows stay. */
  stop() {
    if (this.disposed || !isRunning(this.state.status)) return;
    this.cancel();
    this.run++;
    this.set({ status: { kind: 'stopped', why: 'user' } });
  }

  /** The screen went away: nothing more is sent or told. */
  dispose() {
    this.cancel();
    this.run++;
    this.disposed = true;
  }

  /** The app went to the background: hold the timers. */
  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.due = true;
    }
  }

  /** Back in the foreground: look again at once if a look was waiting. */
  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (!this.due || this.disposed) return;
    this.due = false;
    void this.evaluate(this.run);
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.due = false;
    this.abort?.abort();
    this.abort = null;
  }

  private set(patch: Partial<WaveState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.deps.onChange(this.state);
  }

  private live(run: number) {
    return run === this.run && !this.disposed;
  }

  private later(run: number, ms: number) {
    if (this.paused) {
      this.due = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.evaluate(run);
    }, ms);
  }

  /** Whether the next upload may go yet; schedules the next look when not. */
  private async evaluate(run: number) {
    if (!this.live(run)) return;
    if (this.paused) {
      this.due = true;
      return;
    }
    // Waiting on the follow requests (the status says so until they let it go).
    if (this.state.status.kind === 'waitingRequests') {
      let requests: readonly PodcastRequest[];
      try {
        requests = await this.deps.listRequests();
      } catch {
        // Not known: look again later.
        if (this.live(run)) this.later(run, FOLLOW_REQUEST_POLL_MS);
        return;
      }
      if (!this.live(run)) return;
      const open = new Set(requests.filter(isOpenRequest).map((r) => r.id));
      const mine = this.state.rows.some(
        (r) =>
          (r.status === 'queued' || r.status === 'already_queued') &&
          r.request_id !== null &&
          open.has(r.request_id),
      );
      if (mine || open.size >= OPEN_REQUEST_CAP) {
        this.later(run, FOLLOW_REQUEST_POLL_MS);
        return;
      }
    }
    const left = this.notBefore - this.now();
    if (left > 0) {
      const status = this.state.status;
      if (status.kind !== 'waitingTime' || status.at !== this.notBefore) {
        this.set({
          status: {
            kind: 'waitingTime',
            at: this.notBefore,
            why: this.busyStreak > 0 ? 'busy' : 'spacing',
          },
        });
      }
      this.later(run, left);
      return;
    }
    await this.upload(run);
  }

  private async upload(run: number) {
    if (!this.live(run)) return;
    if (!this.deps.mayAct()) {
      this.set({ status: { kind: 'stopped', why: 'cantAct' } });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.set({ status: { kind: 'uploading' } });
    const startedAt = this.now();
    let result: OpmlImportResult;
    try {
      result = await this.deps.upload(abort.signal);
    } catch (e) {
      if (this.live(run)) this.refused(run, e);
      return;
    } finally {
      if (this.abort === abort) this.abort = null;
    }
    if (!this.live(run)) return;
    this.busyStreak = 0;
    const before = limitedOf(this.state.rows);
    const rows = mergeRows(this.state.rows, result.rows);
    const after = limitedOf(rows);
    this.deps.onWave?.(result);
    const status: WaveStatus =
      after.size === 0
        ? { kind: 'done' }
        : before.size > 0 && [...before].every((i) => after.has(i))
          ? { kind: 'stalled' }
          : { kind: 'waitingRequests' };
    this.set({ rows, status });
    if (status.kind !== 'waitingRequests') return;
    this.notBefore = startedAt + WAVE_SPACING_MS;
    await this.evaluate(run);
  }

  /** An upload that was refused or got no answer. */
  private refused(run: number, e: unknown) {
    const busy =
      e instanceof ApiError && (e.status === 429 || (e.status === 503 && e.code === 'opml_busy'))
        ? (e.retryAfterSeconds ?? (e.status === 429 ? RATE_LIMITED_FALLBACK_S : BUSY_FALLBACK_S))
        : null;
    if (busy === null) {
      this.set({
        status: { kind: 'failed', code: e instanceof ApiError ? (e.code ?? null) : null },
      });
      return;
    }
    this.busyStreak++;
    if (this.busyStreak >= BUSY_STOP_AFTER) {
      this.set({ status: { kind: 'stopped', why: 'busy' } });
      return;
    }
    this.notBefore = this.now() + busy * 1000;
    void this.evaluate(run);
  }
}
