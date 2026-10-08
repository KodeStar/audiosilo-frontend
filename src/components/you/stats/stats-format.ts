import { formatDurationOrZero } from '@/lib/format';

/** A duration as a stat tile sets it, the figures big and the units small:
 * `[{ n: '11', unit: 'h' }, { n: '6', unit: 'm' }]` for 11h 6m. */
export function durationParts(seconds: number): { n: string; unit: string }[] {
  return Array.from(formatDurationOrZero(seconds).matchAll(/(\d+)([a-z]+)/g), (m) => ({
    n: m[1],
    unit: m[2],
  }));
}
