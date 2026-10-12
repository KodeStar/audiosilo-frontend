/**
 * Whether CarPlay or Android Auto is connected now, as last heard (`carNative.onConnection`;
 * false until then and after the car sync stops). Written by the car sync's listener and, on
 * iOS, by the car start's (`register-car-task.ios.ts`), the first listener and so the only one
 * that hears the connect native queued before JS listened; the sync, starting while it is
 * true, runs its connect path once itself. The car's headless task stays while a car is
 * connected, and the nightly auto sleep timer never arms in a car. Its own module so no
 * reader imports the car sync.
 */
let connected = false;

export function isCarConnected(): boolean {
  return connected;
}

/** A car connected or left (or the car sync stopped listening: false). */
export function setCarConnected(value: boolean): void {
  connected = value;
}
