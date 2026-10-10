import { carNative } from './car-native';

/**
 * iOS: start the car's work when CarPlay connects, without waiting for the React tree. At a
 * CarPlay-first launch the root layout never renders (see `startCarWork`), so nothing it
 * starts would answer the car. Imported from `index.ts` before Expo Router's entry, so the
 * listener is the first: the connect native queued until JS listened (`AudiosiloCarEvents`)
 * reaches it. The car code is loaded only once a car connects, so a phone that never meets a
 * car evaluates nothing more than before. A no-op on a binary without the car functions
 * (`carNative.available`).
 */
let connected = false;

carNative.onConnection((now) => {
  connected = now;
  if (!now) return;
  try {
    // Required here, not at the top: loaded only once a car connects.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startCarWork } = require('./car-task') as typeof import('./car-task');
    startCarWork(() => connected).catch((err) => console.warn('[car] the car start failed', err));
  } catch (err) {
    console.warn('[car] the car start failed', err);
  }
});
