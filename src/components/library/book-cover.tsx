import { useState } from 'react';
import { PixelRatio, View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import type { CoverSize } from '@/api/types';
import { Cover } from '@/components/ui/cover';
import { useDownloadEntry } from '@/downloads/store';
import { cn } from '@/lib/utils';

import { CoverFrame } from './cover-frame';

/** The thumbnail sizes the server makes (`cover_sizes`), smallest first. */
export const COVER_SIZES: readonly CoverSize[] = [160, 320, 640];

/**
 * The smallest thumbnail that covers a cover drawn `width` points wide on a screen of
 * `pixelRatio`, or undefined when even the largest is too small (then the full art is
 * the sharpest there is).
 */
export function coverSizeFor(width: number, pixelRatio: number): CoverSize | undefined {
  const px = Math.ceil(width * pixelRatio);
  return COVER_SIZES.find((s) => s >= px);
}

/**
 * The sources to try for a cover, best first: the downloaded copy on this device, then
 * the thumbnail (when the server makes them), then the full art. `thumbnails` is the
 * server's `cover_sizes` flag, `undefined` while its `/server` info is unknown: then no
 * remote source is offered yet, so a cover isn't fetched in full only to be replaced by
 * its thumbnail a moment later.
 */
export function coverCandidates(opts: {
  local?: string | null;
  thumbnails: boolean | undefined;
  url: (size?: CoverSize) => string | null;
  size?: CoverSize;
}): string[] {
  const out: string[] = [];
  if (opts.local) out.push(opts.local);
  if (opts.thumbnails === undefined) return out;
  const thumb = opts.thumbnails && opts.size ? opts.url(opts.size) : null;
  const full = opts.url();
  if (thumb) out.push(thumb);
  if (full) out.push(full);
  return out;
}

export type BookCoverProps = {
  /** The book's own server (a cover always comes from the book's connection). */
  connectionId: string;
  libraryId: number;
  path: string;
  /** `Book.cover_version` when known (absent on progress/favourite/folder rows). */
  coverVersion?: string;
  /** Drawn width in points; the cover is square. */
  width: number;
  /** Shown (with `author`) when there is no art. */
  title?: string;
  author?: string;
  /** `lg` for a hero cover's deeper shadow; `xs` (default) for tiles and rows. */
  shadow?: 'xs' | 'lg';
  /** Layout classes for the frame (margins, self-alignment). */
  className?: string;
};

/**
 * A book's cover art (STYLEGUIDE section 8 "Cover"): square, radius 5, framed with the
 * cover shadow (`CoverFrame`). Sources, best first (`coverCandidates`): the downloaded
 * copy when the book is on this device; the smallest server thumbnail that covers
 * `width` x the pixel ratio (`coverSizeFor`, only when the server advertises
 * `cover_sizes`); the full art, which is also where a failed thumbnail falls back to (a
 * thumbnail 404 means the server can't make one). `cover_version` rides along as the
 * cache buster. With no art at all it shows the title and author. While the server's
 * flags are unknown it shows an empty frame rather than fetching the full art first.
 */
export function BookCover({
  connectionId,
  libraryId,
  path,
  coverVersion,
  width,
  title,
  author,
  shadow = 'xs',
  className,
}: BookCoverProps) {
  const api = useOptionalApi(connectionId);
  const info = useServerInfo(connectionId);
  // Unknown while `/server` loads; an unreachable server counts as "no thumbnails".
  const thumbnails = info.data
    ? !!info.data.capabilities.cover_sizes
    : info.isError
      ? false
      : undefined;
  const entry = useDownloadEntry(connectionId, libraryId, path);
  const local = entry?.status === 'downloaded' ? entry.manifest.coverUri : null;
  const candidates = coverCandidates({
    local,
    thumbnails: api ? thumbnails : false,
    url: (size) => (api ? api.coverUrl(libraryId, path, { size, version: coverVersion }) : null),
    size: coverSizeFor(width, PixelRatio.get()),
  });
  // URIs that failed to load. Keyed by URI, not reset: a recycled list cell moving to
  // another book gets new URIs, which none of these match.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const uri = candidates.find((c) => !failed.includes(c));
  const pending = !uri && thumbnails === undefined && !!api;
  const source = uri ? (uri === local ? uri : { uri, headers: api?.authHeaders() }) : null;

  return (
    <CoverFrame size={shadow} className={cn('rounded-cover', className)}>
      <View style={{ width, height: width }}>
        <Cover
          source={source}
          label={pending ? undefined : title}
          sublabel={pending ? undefined : author}
          rounded="rounded-none"
          size={width}
          onError={() => {
            if (uri) setFailed((f) => (f.includes(uri) ? f : [...f, uri]));
          }}
        />
      </View>
    </CoverFrame>
  );
}
