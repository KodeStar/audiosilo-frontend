import { useState } from 'react';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { coverCandidates, coverSizeFor } from '@/components/library/book-cover';
import { CoverFrame } from '@/components/library/cover-frame';
import { Cover } from '@/components/ui/cover';

import { CARD_DESIGN_WIDTH } from './card-size';
import { PlainCover, type StoryCoverProps } from './plain-cover';
import { SHARE_WIDTH } from './share-types';

/**
 * Web: a book's cover on a story card as a plain same-origin URL (media auth rides in
 * the URL as `?token=`), never the `blob:` copy `BookCover` makes on the web when it
 * sends the token as a header too: the share rasteriser inlines each image with a
 * `fetch()`, and the player's CSP (`connect-src 'self'`) refuses a `blob:` URL. Sized for
 * the 1080-wide share image, so a shared cover stays sharp; a failed thumbnail falls back
 * to the full art, then to the title on cloth.
 */
export function StoryCoverArt({ connectionId, book, width, plain }: StoryCoverProps) {
  const api = useOptionalApi(connectionId);
  const info = useServerInfo(connectionId);
  const thumbnails = info.data
    ? !!info.data.capabilities.cover_sizes
    : info.isError
      ? false
      : undefined;
  const candidates = coverCandidates({
    thumbnails: api ? thumbnails : false,
    url: (size) => (api ? api.coverUrl(book.library_id, book.path, { size }) : null),
    size: coverSizeFor(width, SHARE_WIDTH / CARD_DESIGN_WIDTH),
  });
  const [failed, setFailed] = useState<readonly string[]>([]);
  const uri = candidates.find((c) => !failed.includes(c));
  if (plain || (!uri && thumbnails !== undefined)) return <PlainCover book={book} width={width} />;
  return (
    <CoverFrame size={width > 100 ? 'lg' : 'xs'} className="rounded-cover">
      <Cover
        source={uri ?? null}
        rounded="rounded-none"
        size={width}
        onError={() => {
          if (uri) setFailed((f) => (f.includes(uri) ? f : [...f, uri]));
        }}
      />
    </CoverFrame>
  );
}
