import { smartSpeedApplies } from '@/playback/effects';

/**
 * What the Smart Speed and Voice Boost switches say and allow, on each platform
 * (STYLEGUIDE section 8 "Speed", contract decisions 6-8). Pure, so the copy rules are
 * tested without rendering; `effects-settings.tsx` turns the line keys into words.
 */

/** The caption lines under each switch, by their `effects.*` meaning. */
export type SmartSpeedLine = 'hint' | 'saved' | 'downloadedOnly' | 'notInBrowser';
export type VoiceBoostLine = 'hint' | 'notInThisBrowser';

export type EffectRow<Line extends string> = { checked: boolean; disabled: boolean; lines: Line[] };

/** Time saved is shown once there is a whole second of it. */
export const hasSaved = (seconds: number): boolean => Math.round(seconds) >= 1;

/**
 * The Smart Speed switch. The web has no engine for it: off, disabled, "Not available in
 * the browser". Elsewhere: what it does, the lifetime "Saved 2h 11m" once there is some,
 * and on an iPhone, with it on and a book loaded that isn't all on the device (or none
 * loaded), "For downloaded books on iPhone".
 */
export function smartSpeedRow(input: {
  platform: string;
  on: boolean;
  savedSeconds: number;
  queue: { tracks: readonly { url: string }[] } | null | undefined;
}): EffectRow<SmartSpeedLine> {
  const { platform, on, savedSeconds, queue } = input;
  if (platform === 'web') return { checked: false, disabled: true, lines: ['notInBrowser'] };
  const lines: SmartSpeedLine[] = ['hint'];
  if (hasSaved(savedSeconds)) lines.push('saved');
  if (on && platform === 'ios' && !smartSpeedApplies(platform, queue)) lines.push('downloadedOnly');
  return { checked: on, disabled: false, lines };
}

/** The Voice Boost switch: everywhere but a browser that can't run it (Safari), which
 * gets it off, disabled, "Not available in this browser". */
export function voiceBoostRow(input: {
  platform: string;
  on: boolean;
  supported: boolean;
}): EffectRow<VoiceBoostLine> {
  const { platform, on, supported } = input;
  if (platform === 'web' && !supported) {
    return { checked: false, disabled: true, lines: ['notInThisBrowser'] };
  }
  return { checked: on, disabled: false, lines: ['hint'] };
}

/** What the full player's effects pill reads, or null for no pill (nothing on). */
export type EffectsPill =
  { kind: 'saved'; seconds: number } | { kind: 'voiceBoost' } | { kind: 'smartSpeed' };

/**
 * The full player's effects state (STYLEGUIDE section 8 "Full player": "Saved 2h 11m"
 * native, "Voice boost" web): the time saved while Smart Speed is on and has saved some,
 * else the effect that is on. The web only ever has Voice Boost, where it can run.
 */
export function effectsPill(input: {
  platform: string;
  smartSpeed: boolean;
  voiceBoost: boolean;
  voiceBoostSupported: boolean;
  savedSeconds: number;
}): EffectsPill | null {
  const { platform, smartSpeed, voiceBoost, voiceBoostSupported, savedSeconds } = input;
  if (platform === 'web') return voiceBoost && voiceBoostSupported ? { kind: 'voiceBoost' } : null;
  if (smartSpeed && hasSaved(savedSeconds)) return { kind: 'saved', seconds: savedSeconds };
  if (voiceBoost) return { kind: 'voiceBoost' };
  if (smartSpeed) return { kind: 'smartSpeed' };
  return null;
}
