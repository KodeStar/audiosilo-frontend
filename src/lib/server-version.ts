/** A version's major, minor and patch ("2.6.0", "v2.6.0", "2.6.0-rc.1"), or null when it is
 * not one (a development build's "dev"). */
function parts(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether a server's `version` (`GET /server`) is `min` or later: what tells a behaviour that
 * has no capability flag of its own apart. Undefined when either is not a version (not
 * known yet, or a development build), so a caller picks its own default.
 */
export function versionAtLeast(version: string | undefined, min: string): boolean | undefined {
  const have = version === undefined ? null : parts(version);
  const want = parts(min);
  if (!have || !want) return undefined;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}
