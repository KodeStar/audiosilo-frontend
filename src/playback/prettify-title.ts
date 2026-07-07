/**
 * Display-only helper: turn a raw chapter/track label into something readable for
 * the player's primary title line, WITHOUT inventing content.
 *
 * Audiobook "chapter" labels are often just the underlying audio *filename*
 * (`01_the_hobbit_ch1.mp3`), which reads as the loudest, ugliest text in the
 * player. When a label looks like a filename - it carries an audio extension
 * and/or underscores - we strip the extension and turn underscores into spaces.
 * Real metadata titles (no extension, no underscores - e.g. "Chapter 1" or
 * "The Shadow of the Past") are returned untouched.
 *
 * Deliberately conservative: hyphens and dots inside a name are left alone (they
 * appear in genuine titles like "Mother-in-law" or "3.5 The Interlude"), and an
 * empty/whitespace string is returned as-is.
 */
const AUDIO_EXT = /\.(mp3|m4a|m4b|mp4|aac|ogg|oga|opus|flac|wav|wma|alac|aif|aiff)$/i;

// A trailing encoder bitrate tag left over from a rip's filename, e.g. "64kb",
// "128 kbps", "32k". Only stripped for filename-shaped labels, only when it is the
// final token (preceded by a separator), so genuine chapter numbers survive.
const BITRATE_TAIL = /(^|\s)\d{2,3}\s?(k|kb|kbps)$/i;

export function prettifyChapterTitle(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const hasExt = AUDIO_EXT.test(trimmed);
  const hasUnderscore = trimmed.includes('_');
  // Not filename-shaped -> it's a real title; leave it exactly as given.
  if (!hasExt && !hasUnderscore) return raw;

  const cleaned = trimmed.replace(AUDIO_EXT, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // Strip a trailing bitrate token (filename-shaped only); keep the pre-strip value
  // if removing it would leave nothing.
  const debitrated = cleaned.replace(BITRATE_TAIL, '').trim() || cleaned;
  // Never return an empty string (e.g. a bare "_.mp3"); fall back to the original.
  return debitrated || raw;
}
