import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

import { overallStatus } from './merge-model';
import type { Source } from './use-journal-sources';

/**
 * Quiet per-server lines above a Journal list: a server that failed to answer (with a
 * retry), and, beside servers that can, one that can't list bookmarks or notes yet (an
 * older server). Nothing when only one server is involved and the page's own empty or
 * error state already says it, so a single server's failure is never said twice.
 */
export function ServerNotes({
  sources,
  kind,
}: {
  sources: Source<unknown>[];
  kind: 'history' | 'bookmarks' | 'notes';
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const overall = overallStatus(sources);
  // Every server failed or none can list: the page's own state says it.
  if (overall === 'error' || overall === 'unsupported') return null;
  const notes = sources.flatMap((s): { id: string; text: string; retry?: () => void }[] => {
    if (s.status === 'error') {
      return [
        {
          id: s.connectionId,
          text: t(`journal.servers.failed.${kind}`, { server: s.connectionName }),
          retry: s.refetch,
        },
      ];
    }
    if (s.status === 'unsupported' && kind !== 'history') {
      return [
        {
          id: s.connectionId,
          text: t(`journal.servers.unsupported.${kind}`, { server: s.connectionName }),
        },
      ];
    }
    return [];
  });
  if (notes.length === 0) return null;
  return (
    <View className="gap-2 pb-4">
      {notes.map((n) => (
        <View key={n.id} className="flex-row items-center gap-2">
          <Icon name="server" size={13} color={themed.mutedForeground} />
          <Text variant="caption" className="flex-1">
            {n.text}
          </Text>
          {n.retry ? (
            <Button variant="ghost" size="sm" title={t('common.retry')} onPress={n.retry} />
          ) : null}
        </View>
      ))}
    </View>
  );
}
