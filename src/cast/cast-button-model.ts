import { castBlockReason, type CastBlockReason } from './cast-media';
import type { CastStatus } from './cast-state';
import type { Book, ChaptersResponse } from '@/api/types';

/** What the Cast button shows: nothing, a button that explains why this book can't be cast
 * (`blocked`), or the button that casts. */
export type CastButtonModel = {
  show: boolean;
  blocked: CastBlockReason | null;
  status: CastStatus;
  deviceName: string | null;
};

/**
 * The Cast button's rule, pure: shown only while a book is loaded, on a device that can
 * cast (`supported`: the native module in this binary with Play services, or Chromium in a
 * secure context) and when the book's server has `cast` (an older server, or one whose
 * flags aren't known yet: no button). Shown while a session is connected whatever the book,
 * so it can always be stopped. Blocked (it explains instead of casting) when the address in
 * use is this device, or the book needs a transcoder the server lacks.
 */
export function castButtonModel(input: {
  loaded: boolean;
  supported: boolean | null;
  canCast: boolean | undefined;
  canTranscode: boolean | undefined;
  baseUrl: string | null;
  book?: Pick<Book, 'codec' | 'direct_playable'> | null;
  chapters?: Pick<ChaptersResponse, 'codec' | 'direct_playable'> | null;
  status: CastStatus;
  deviceName: string | null;
}): CastButtonModel {
  const { status, deviceName } = input;
  const connected = status !== 'off';
  const show = input.supported === true && (connected || (input.loaded && input.canCast === true));
  const blocked =
    show && !connected
      ? castBlockReason({
          canCast: input.canCast,
          canTranscode: input.canTranscode,
          baseUrl: input.baseUrl,
          book: input.book,
          chapters: input.chapters,
        })
      : null;
  return { show, blocked, status, deviceName };
}
