import { useDownloadEntry } from '@/downloads/store';
import { Icon } from '@/components/ui/icon';
import { colors } from '@/theme/tokens';

/** Small indicator for list rows: a check when downloaded, an arrow while in
 * flight, nothing otherwise. */
export function DownloadBadge({ libraryId, path, size = 13 }: { libraryId: number; path: string; size?: number }) {
  const entry = useDownloadEntry(libraryId, path);
  if (!entry) return null;
  if (entry.status === 'downloaded') return <Icon name="check" size={size} color={colors.primary} />;
  if (entry.status === 'downloading' || entry.status === 'queued') {
    return <Icon name="download" size={size} color={colors.dark.textMuted} />;
  }
  return null;
}
