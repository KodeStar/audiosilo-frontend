import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormError } from '@/components/ui/form-error';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';
import { openDownloads } from '@/lib/open';
import { useNow } from '@/lib/use-now';
import { useSession } from '@/stores/session';
import { setUpWatch } from '@/watch/send';
import { useWatchStatus, watchErrorText } from '@/watch/use-watch';
import {
  serverServesWatch,
  type WatchState,
  watchCardStatus,
  watchCardVisible,
} from '@/watch/watch-model';
import { useWatchStore } from '@/watch/watch-store';

/**
 * The account page's "Apple Watch" card, for a phone with a paired watch and an account that can
 * use one (never a kid's or a demo's): Set up signs the watch in to this server with no typing
 * (a `pair` message), Send again does it once more. Once the watch says it is signed in here, who
 * as, the listening it still has to send and when it last synced. The books on it are in Downloads
 * (`WatchSection`).
 */
export function AppleWatchCard({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const watch = useWatchStatus();
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  const api = useOptionalApi(connectionId);
  const { data: server } = useServerInfo(connectionId);
  const pairUntil = useWatchStore((s) => s.pairUntil[connectionId]);
  const visible = !!connection && watchCardVisible(watch, connection.user);
  // Quicker while a pair is out: the card says when it has run out.
  const now = useNow(pairUntil === undefined ? 60_000 : 15_000, visible);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!connection || !visible) return null;

  const serverName = connection.name;
  const status = watchCardStatus(watch, connection, pairUntil, now);
  const here = status === 'signed-in' ? watch.state : null;
  const serves = serverServesWatch(server?.renditions);

  const send = async () => {
    if (!api || sending) return;
    setError(null);
    setSending(true);
    try {
      await setUpWatch(api, connection);
    } catch (e) {
      setError(watchErrorText(e, serverName, t));
    } finally {
      setSending(false);
    }
  };

  const body = {
    install: t('account.watch.install'),
    setup: t('account.watch.setupBody', { server: serverName }),
    sent: t('account.watch.sent'),
    expired: t('account.watch.expired'),
    'signed-in': t('account.watch.signedInAs', {
      user: connection.user.username,
      server: serverName,
    }),
    'other-account': t('account.watch.otherAccount', { server: serverName }),
  }[status];

  return (
    <Card className="gap-3" testID="apple-watch-card">
      <View className="gap-0.5">
        <Text variant="title" accessibilityRole="header">
          {t('account.watch.title')}
        </Text>
        <Text variant="muted">{body}</Text>
        {here ? <WatchSyncLines state={here} now={now} /> : null}
      </View>
      {server && !serves ? (
        <Text variant="caption">{t('account.watch.serverCannot', { server: serverName })}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {status !== 'install' && serves ? (
          <Button
            variant="outline"
            icon="watch"
            title={t(
              status === 'setup' || status === 'other-account'
                ? 'account.watch.setUp'
                : 'account.watch.sendAgain',
            )}
            loading={sending}
            onPress={() => void send()}
          />
        ) : null}
        {status !== 'install' ? (
          <Button
            variant="ghost"
            icon="download"
            title={t('account.watch.booksLink')}
            onPress={() => openDownloads(connectionId)}
          />
        ) : null}
      </View>
      <FormError error={error} />
    </Card>
  );
}

/** What the watch still has to send, and when it last synced. */
function WatchSyncLines({ state, now }: { state: WatchState; now: number }) {
  const { t, i18n } = useTranslation();
  return (
    <>
      {state.unsent_events > 0 ? (
        <Text variant="caption">{t('account.watch.waiting', { count: state.unsent_events })}</Text>
      ) : state.last_sync_at && state.couldnt_sync === 0 ? (
        <Text variant="caption">{t('account.watch.allSynced')}</Text>
      ) : null}
      {state.couldnt_sync > 0 ? (
        <Text variant="caption">
          {t('account.watch.couldntSync', { count: state.couldnt_sync })}
        </Text>
      ) : null}
      <Text variant="caption">
        {state.last_sync_at
          ? t('account.watch.lastSynced', {
              when: formatRelative(state.last_sync_at, i18n.language || 'en', now),
            })
          : t('account.watch.neverSynced')}
      </Text>
    </>
  );
}
