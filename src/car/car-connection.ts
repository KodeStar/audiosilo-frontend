/**
 * Whether CarPlay or Android Auto is connected now, as the car sync last heard it
 * (`carNative.onConnection`; false until then and after the sync stops). The car sync writes
 * it; the car's headless task stays while a car is connected, and the nightly auto sleep
 * timer never arms in a car. Its own module so neither reader imports the car sync.
 */
let connected = false;

export function isCarConnected(): boolean {
  return connected;
}

/** The car sync heard the car connect or leave (or stopped listening: false). */
export function setCarConnected(value: boolean): void {
  connected = value;
}
