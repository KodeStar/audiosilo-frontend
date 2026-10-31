import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { formatClock, formatRelative } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { type CouldNotSync, discardFailed } from '@/playback/listening-outbox';
import { useListeningSync } from '@/playback/use-listening-sync';
import { tabularNums } from '@/theme/tabular-nums';

/** The reasons the card has words for; any other reads as `invalid`. */
const REASONS = [
  'duration_mismatch',
  'too_old',
  'no_access',
  'not_found',
  'unknown_kind',
  'invalid',
] as const;
type Reason = (typeof REASONS)[number];

/** A rejected event's reason as the card names it. */
export function reasonKey(reason: string): Reason {
  return (REASONS as readonly string[]).includes(reason) ? (reason as Reason) : 'invalid';
}

/** What a couldn't-sync row says it was: "Book · 1:02:13 to 1:40:00" or "Book · Marked
 * finished". */
export function failedWhat(item: CouldNotSync, t: TFunction): string {
  const { event } = item;
  const what =
    event.kind === 'listen'
      ? t('account.listeningSync.span', {
          from: formatClock(event.from_pos),
          to: formatClock(event.to_pos),
        })
      : t(
          event.kind === 'finish'
            ? 'account.listeningSync.finished'
            : 'account.listeningSync.unfinished',
        );
  // The book by its folder's last part ("Author/Book" -> "Book").
  return `${pathLeaf(event.path) || event.path} · ${what}`;
}

/**
 * The account's "Listening sync" card (Sync v2, capability `listening_sync`): how many
 * listens wait to reach this server, when this device last synced, and the events the
 * server rejected (the "couldn't sync" list, each with why and a Discard; they are kept 30
 * days). Shown for a server with the capability, or while there is anything to show.
 */
export function ListeningSyncCard({
  connectionId,
  serverName,
  supported,
}: {
  connectionId: string;
  serverName: string;
  /** The server's `listening_sync` flag. */
  supported: boolean;
}) {
  const { t, i18n } = useTranslation();
  const sync = useListeningSync(connectionId);
  const now = useNow(60_000);
  if (!supported && sync.waiting === 0 && sync.failed.length === 0) return null;

  const status =
    sync.waiting > 0
      ? t('account.listeningSync.waiting', { count: sync.waiting })
      : t('account.listeningSync.allSynced', { server: serverName });
  const last = sync.lastSyncAt
    ? t('account.listeningSync.lastSynced', {
        when: formatRelative(sync.lastSyncAt, i18n.language || 'en', now),
      })
    : t('account.listeningSync.neverSynced');

  return (
    <Card className="gap-3" testID="listening-sync-card">
      <View className="gap-0.5">
        <Text variant="title" accessibilityRole="header">
          {t('account.listeningSync.title')}
        </Text>
        <Text variant="muted">{status}</Text>
        <Text variant="caption">{last}</Text>
      </View>
      {sync.failed.length > 0 ? (
        <View className="gap-2">
          <View className="gap-0.5">
            <Text variant="label">{t('account.listeningSync.failedTitle')}</Text>
            <Text variant="caption">
              {t('account.listeningSync.failedBody', { server: serverName })}
            </Text>
          </View>
          <View className="overflow-hidden rounded-card border border-border">
            {sync.failed.map((item, i) => {
              const what = failedWhat(item, t);
              return (
                <View
                  key={item.event.id}
                  className={cn(
                    'flex-row items-center gap-3 px-4 py-3',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-[13px]" style={tabularNums} numberOfLines={2}>
                      {what}
                    </Text>
                    <Text variant="caption">
                      {t(`account.listeningSync.reason.${reasonKey(item.reason)}`)}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('account.listeningSync.discard')}
                    accessibilityLabel={t('account.listeningSync.discardLabel', { what })}
                    onPress={() => void discardFailed(connectionId, item.event.id)}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </Card>
  );
}
