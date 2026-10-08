/**
 * The story's listening clock (STYLEGUIDE section 8: 24 radial petals from 00 at the
 * top, the busiest hours bright), as SVG paths. Pure, so the geometry is tested.
 */

export type ClockPetal = { hour: number; d: string; peak: boolean };

/** A petal at least this share of the busiest hour's listening is drawn bright. */
const PEAK_SHARE = 0.75;
/** Degrees left open between petals. */
const GAP_DEG = 1.6;

/** The clock's rings: the petals grow from `inner` to at most `outer` (radii). */
export function clockRadii(size: number): { inner: number; outer: number } {
  return { inner: size * 0.22, outer: size * 0.42 };
}

/** Where an hour of the clock sits: 00 at the top, clockwise. */
export function hourAngle(hour: number): number {
  return ((hour / 24) * 360 - 90) * (Math.PI / 180);
}

/** One petal per hour, its length the hour's share of the busiest one. Hours without
 * listening get no petal. */
export function clockPetals(hours: readonly number[], size: number): ClockPetal[] {
  const max = Math.max(0, ...hours);
  if (max <= 0) return [];
  const c = size / 2;
  const { inner, outer } = clockRadii(size);
  const gap = GAP_DEG * (Math.PI / 180);
  const at = (a: number, r: number) =>
    `${(c + Math.cos(a) * r).toFixed(1)} ${(c + Math.sin(a) * r).toFixed(1)}`;
  const petals: ClockPetal[] = [];
  hours.forEach((v, hour) => {
    if (v <= 0) return;
    const a0 = hourAngle(hour) + gap;
    const a1 = hourAngle(hour + 1) - gap;
    const r = inner + (outer - inner) * (v / max);
    const rr = r.toFixed(1);
    const ri = inner.toFixed(1);
    petals.push({
      hour,
      d: `M${at(a0, inner)} L${at(a0, r)} A${rr} ${rr} 0 0 1 ${at(a1, r)} L${at(a1, inner)} A${ri} ${ri} 0 0 0 ${at(a0, inner)}Z`,
      peak: v >= max * PEAK_SHARE,
    });
  });
  return petals;
}
