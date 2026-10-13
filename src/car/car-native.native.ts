import AudiosiloPlayer from '../../modules/audiosilo-player';

import { resolveConnectionId } from '@/lib/connection-id';

import type { CarNative } from './car-native';

/**
 * iOS and Android: the module's car functions, each feature-detected (`typeof === 'function'`,
 * like `setVolume` in `service.native.ts`), so an installed binary without them keeps
 * today's behaviour with no error. The car events are only listened to on a binary that has
 * the car functions: an older one never declared them.
 */
const has = (fn: unknown): boolean => typeof fn === 'function';

const available = has(AudiosiloPlayer.setCarSnapshot);

export const carNative: CarNative = {
  available,

  async stopPlayback() {
    if (has(AudiosiloPlayer.reset)) await AudiosiloPlayer.reset();
  },

  async setSnapshot(json) {
    if (!available) return false;
    try {
      await AudiosiloPlayer.setCarSnapshot!(json);
      return true;
    } catch (err) {
      console.warn('[car] the snapshot was not taken', err);
      return false;
    }
  },

  // The service's book carries the connection id of the play spec or load that started it,
  // which can be from before the identity migration (an old car snapshot's spec): it reads as
  // the new id (`resolveConnectionId`), so the store adopts it once instead of seeing another
  // book on every check.
  async getLoadedBook() {
    if (!has(AudiosiloPlayer.getLoadedBook)) return null;
    try {
      const loaded = (await AudiosiloPlayer.getLoadedBook!()) ?? null;
      return loaded && { ...loaded, connectionId: resolveConnectionId(loaded.connectionId) };
    } catch {
      return null;
    }
  },

  // Queued while no JS ran, possibly before the identity migration: each reads on the new
  // connection id (`resolveConnectionId`), like the loaded book and a bookmark press.
  async consumePendingBookmarks() {
    if (!has(AudiosiloPlayer.consumePendingBookmarks)) return [];
    try {
      const list = await AudiosiloPlayer.consumePendingBookmarks!();
      return Array.isArray(list)
        ? list.map((b) => ({ ...b, connectionId: resolveConnectionId(b.connectionId) }))
        : [];
    } catch {
      return [];
    }
  },

  onConnection(handler) {
    if (!available) return () => undefined;
    const sub = AudiosiloPlayer.addListener('onCarConnection', (e) => handler(!!e?.connected));
    return () => sub.remove();
  },

  onPlayRequest(handler) {
    if (!available) return () => undefined;
    const sub = AudiosiloPlayer.addListener('onCarPlayRequest', (e) => {
      if (typeof e?.id === 'string') handler(e.id);
    });
    return () => sub.remove();
  },

  onBookmark(handler) {
    if (!available) return () => undefined;
    const sub = AudiosiloPlayer.addListener('onRemoteBookmark', (e) => {
      const { trackIndex, position } = e;
      if (!Number.isFinite(trackIndex) || !Number.isFinite(position)) return;
      // The engine's own book (a binary that knows `load`'s book sends it): the press belongs to the book the
      // listener heard, whichever the store holds right now.
      const book =
        typeof e.connectionId === 'string' &&
        e.connectionId !== '' &&
        typeof e.path === 'string' &&
        e.path !== '' &&
        Number.isSafeInteger(e.libraryId)
          ? {
              connectionId: resolveConnectionId(e.connectionId),
              libraryId: e.libraryId as number,
              path: e.path,
            }
          : undefined;
      handler(trackIndex, position, book);
    });
    return () => sub.remove();
  },
};
