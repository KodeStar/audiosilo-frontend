/**
 * A count read from a native module, as a JS number.
 *
 * Since Expo SDK 58 the iOS bridge (expo-modules-jsi) encodes a Swift `Int64`/`UInt64` as a JS
 * `bigint`, whatever its magnitude, while the TypeScript types still say `number`. expo-file-system
 * returns `Int64` for `File.size`, `Directory.size`, `Paths.totalDiskSpace`/`availableDiskSpace` and
 * a download task's progress, and a bigint throws as soon as it meets a number (`Math.max`,
 * `+`, `/`). Android's bridge sends a Kotlin `Long` as a number. Every such read goes through
 * here, at the call into the module.
 *
 * A bigint becomes the nearest number (byte counts never reach 2^53); anything that is not a
 * finite number (null, undefined, NaN) becomes [fallback].
 */
export function nativeNumber(value: number | bigint | null | undefined, fallback = 0): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
