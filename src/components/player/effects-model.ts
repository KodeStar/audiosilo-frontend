import { smartSpeedApplies } from '@/playback/effects';

/**
 * What the Smart Speed and Voice Boost switches say and allow, on each platform
 * (STYLEGUIDE section 8 "Speed", contract decisions 6-8). Pure, so the copy rules are
 * tested without rendering; `effects-settings.tsx` turns the line keys into words.
 */

/** The caption lines under each switch, by their `effects.*` meaning. */
export type SmartSpeedLine = 'hint' | 'saved' | 'notOnIphone' | 'notInBrowser';
export type VoiceBoostLine = 'hint' | 'notInThisBrowser';

export type EffectRow<Line extends string> = { checked: boolean; disabled: boolean; lines: Line[] };

/** Time saved is shown once there is a whole second of it. */
export const hasSaved = (seconds: number): boolean => Math.round(seconds) >= 1;

/**
 * The Smart Speed switch. Where there is no engine for it, off and disabled with the reason:
 * the web "Not available in the browser", iOS "Not available on iPhone yet" (`smartSpeedApplies`).
 * Android: what it does, and the lifetime "Saved 2h 11m" once there is some.
 */
export function smartSpeedRow(input: {
  platform: string;
  on: boolean;
  savedSeconds: number;
}): EffectRow<SmartSpeedLine> {
  const { platform, on, savedSeconds } = input;
  if (!smartSpeedApplies(platform)) {
    const reason: SmartSpeedLine = platform === 'ios' ? 'notOnIphone' : 'notInBrowser';
    return { checked: false, disabled: true, lines: [reason] };
  }
  const lines: SmartSpeedLine[] = ['hint'];
  if (hasSaved(savedSeconds)) lines.push('saved');
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
 * Android, "Voice boost" web and iOS): the time saved while Smart Speed is on and has saved
 * some, else the effect that is on. The web and iOS only ever have Voice Boost (Smart Speed
 * runs on Android only, `smartSpeedApplies`).
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
  if (!smartSpeedApplies(platform)) return voiceBoost ? { kind: 'voiceBoost' } : null;
  if (smartSpeed && hasSaved(savedSeconds)) return { kind: 'saved', seconds: savedSeconds };
  if (voiceBoost) return { kind: 'voiceBoost' };
  if (smartSpeed) return { kind: 'smartSpeed' };
  return null;
}
