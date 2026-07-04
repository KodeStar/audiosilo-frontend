import { useActiveCid } from '@/api/provider';
import { useDownloadEntry } from '@/downloads/store';
import { Icon } from '@/components/ui/icon';
import { colors } from '@/theme/tokens';

/** Small indicator for list rows: a check when downloaded, an arrow while in
 * flight, nothing otherwise. Scoped to the card's own connection (falling back to the
 * active one) so a book downloaded on one server doesn't badge another server's card. */
export function DownloadBadge({
  connectionId,
  libraryId,
  path,
  size = 13,
}: {
  /** The card's source connection; defaults to the active connection. */
  connectionId?: string;
  libraryId: number;
  path: string;
  size?: number;
}) {
  const activeId = useActiveCid();
  const entry = useDownloadEntry(connectionId ?? activeId, libraryId, path);
  if (!entry) return null;
  if (entry.status === 'downloaded')
    return <Icon name="check" size={size} color={colors.primary} />;
  if (entry.status === 'downloading' || entry.status === 'queued') {
    return <Icon name="download" size={size} color={colors.dark.textMuted} />;
  }
  return null;
}
