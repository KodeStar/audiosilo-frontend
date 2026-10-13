import { create } from 'zustand';

import { castDriver } from './driver';
import type { CastDriver } from './types';

/** Where casting is: no session, a session starting, or connected to `deviceName`. */
export type CastStatus = 'off' | 'connecting' | 'connected';

type CastState = {
  /** Can this device cast at all (null until known)? See `CastDriver.supported`. */
  supported: boolean | null;
  status: CastStatus;
  deviceName: string | null;
};

/** The Cast session as the UI reads it (the Cast button), kept by `startCastSync`
 * (`cast-session.ts`). Its own light module, so the buttons don't load the session glue. */
export const useCast = create<CastState>()(() => ({
  supported: null,
  status: 'off',
  deviceName: null,
}));

/** Make the Cast sender ready (the web loads its script here, once): the Cast button calls
 * it when it first shows. Resolves whether casting is ready. */
export function ensureCastReady(driver: CastDriver = castDriver): Promise<boolean> {
  return driver.init().catch(() => false);
}

/** Web: open the browser's Cast chooser (the native Cast button opens the SDK's itself). */
export function requestCastSession(driver: CastDriver = castDriver): Promise<void> {
  return driver.requestSession?.() ?? Promise.resolve();
}
