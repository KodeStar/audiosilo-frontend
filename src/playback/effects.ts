/**
 * Where Smart Speed and Voice Boost can work (contract decisions 6 and 7). Pure rules,
 * no engine: the speed sheet and Settings ask these to say why a switch is off or what it
 * applies to, and the web engine asks `supportsVoiceBoost` before it builds its graph.
 */

/** What the web engine needs to know about the browser it runs in. */
export type BrowserEnv = {
  userAgent: string;
  /** The browser has a Web Audio `AudioContext` with `createMediaElementSource`. */
  hasWebAudio: boolean;
};

function currentBrowserEnv(): BrowserEnv {
  const userAgent = typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
  const Ctx = typeof AudioContext !== 'undefined' ? AudioContext : undefined;
  const hasWebAudio =
    typeof Ctx === 'function' &&
    typeof (Ctx.prototype as Partial<AudioContext>).createMediaElementSource === 'function' &&
    typeof (Ctx.prototype as Partial<AudioContext>).createDynamicsCompressor === 'function';
  return { userAgent, hasWebAudio };
}

/**
 * Is this a WebKit browser that isn't Chromium: Safari on the Mac, and every browser on
 * an iPhone or iPad (Apple makes them all WebKit: Chrome there says `CriOS`, Firefox
 * `FxiOS`, and an iPad asks for the Mac's page by default). Chromium also says
 * `AppleWebKit`, but with `Chrome`/`Chromium`/`Edg`/`OPR` beside it; Android's
 * browsers are Chromium; Firefox on the desktop is Gecko.
 */
export function isWebKitOnly(userAgent: string): boolean {
  return (
    /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\/|Android/.test(userAgent)
  );
}

/**
 * Can the web engine run Voice Boost here? Needs Web Audio (a media element source and a
 * compressor), and never in Safari or any other WebKit-only browser: routing an `<audio>`
 * element through an `AudioContext` there plays choppy audio, ignores the element's
 * `playbackRate` and suspends on the lock screen (WebKit bugs 240405, 311000, 261554), so
 * the switch says "Not available in this browser" instead. `env` defaults to the running
 * browser; pass one to test.
 */
export function supportsVoiceBoost(env: BrowserEnv = currentBrowserEnv()): boolean {
  return env.hasWebAudio && !isWebKitOnly(env.userAgent);
}

/**
 * Does Smart Speed actually trim THIS book on this platform? Android trims every book; iOS
 * only a book whose every file is on the device (it looks ahead through the local file to
 * find the silences, which a stream can't offer), so a streaming book there gets "For
 * downloaded books on iPhone"; the web never does. An empty queue (nothing loaded) reads
 * as not applying.
 */
export function smartSpeedApplies(
  platform: string,
  queue: { tracks: readonly { url: string }[] } | null | undefined,
): boolean {
  if (platform === 'android') return true;
  if (platform !== 'ios') return false;
  const tracks = queue?.tracks ?? [];
  return tracks.length > 0 && tracks.every((t) => t.url.startsWith('file://'));
}
