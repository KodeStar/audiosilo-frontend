import AudiosiloPlayer from '../../modules/audiosilo-player';

import type { CarNative } from './car-native';

/**
 * iOS and Android: the module's car functions, each feature-detected (`typeof === 'function'`,
 * like `setVolume` in `service.native.ts`), so an installed binary older than Phase 6 keeps
 * today's behaviour with no error. The car events are only listened to on a binary that has
 * the car functions: an older one never declared them.
 */
const has = (fn: unknown): boolean => typeof fn === 'function';

const available = has(AudiosiloPlayer.setCarSnapshot);

export const carNative: CarNative = {
  available,

  async setSnapshot(json) {
    if (!has(AudiosiloPlayer.setCarSnapshot)) return false;
    try {
      await AudiosiloPlayer.setCarSnapshot!(json);
      return true;
    } catch (err) {
      console.warn('[car] the snapshot was not taken', err);
      return false;
    }
  },

  async getLoadedBook() {
    if (!has(AudiosiloPlayer.getLoadedBook)) return null;
    try {
      return (await AudiosiloPlayer.getLoadedBook!()) ?? null;
    } catch {
      return null;
    }
  },

  async consumePendingBookmarks() {
    if (!has(AudiosiloPlayer.consumePendingBookmarks)) return [];
    try {
      const list = await AudiosiloPlayer.consumePendingBookmarks!();
      return Array.isArray(list) ? list : [];
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
};
