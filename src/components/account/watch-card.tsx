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
import { serverDisplayName } from '@/lib/server-display-name';
import { useNow } from '@/lib/use-now';
import { useSession } from '@/stores/session';
import { watchLink } from '@/watch/link';
import { setUpWatch } from '@/watch/send';
import { useWatchStatus, watchErrorText } from '@/watch/use-watch';
import {
  serverServesWatch,
  type WatchState,
  watchCardStatus,
  watchCardVisible,
  watchWording,
} from '@/watch/watch-model';
import { useWatchStore } from '@/watch/watch-store';

/**
 * The account page's watch card ("Apple Watch" on iOS, "Wear OS watch" on Android), for a phone
 * with a paired watch and an account that can use one (never a kid's or a demo's): Set up signs the
 * watch in to this server with no typing (a `pair` message), Send again does it once more. Once the
 * watch says it is signed in here, who as, the listening it still has to send and when it last
 * synced. The books on it are in Downloads (`WatchSection`). With no AudioSilo on the watch, Android
 * offers Install on watch (Play opens on the watch); an iPhone installs from its Watch app.
 */
export function WatchCard({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const kind = watchLink.kind;
  const watch = useWatchStatus();
  const connections = useSession((s) => s.connections);
  const connection = connections.find((c) => c.id === connectionId) ?? null;
  const api = useOptionalApi(connectionId);
  const { data: server } = useServerInfo(connectionId);
  const pairUntil = useWatchStore((s) => s.pairUntil[connectionId]);
  const visible = !!connection && watchCardVisible(watch, connection.user);
  // Quicker while a pair is out: the card says when it has run out.
  const now = useNow(pairUntil === undefined ? 60_000 : 15_000, visible);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installAsked, setInstallAsked] = useState(false);
  if (!connection || !visible) return null;

  const serverName = serverDisplayName(connection, connections);
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

  const openInstall = watchLink.openInstallOnWatch;
  const install = async () => {
    if (!openInstall) return;
    setError(null);
    try {
      await openInstall();
      setInstallAsked(true);
    } catch {
      setError(t('account.watch.installFailed'));
    }
  };

  const body = {
    install: t(watchWording(kind, 'account.watch.install')),
    setup: t('account.watch.setupBody', { server: serverName }),
    sent: t(watchWording(kind, 'account.watch.sent')),
    expired: t('account.watch.expired'),
    'signed-in': t('account.watch.signedInAs', {
      user: connection.user.username,
      server: serverName,
    }),
    'other-account': t('account.watch.otherAccount', { server: serverName }),
  }[status];

  return (
    <Card className="gap-3" testID="watch-card">
      <View className="gap-0.5">
        <Text variant="title" accessibilityRole="header">
          {t(watchWording(kind, 'account.watch.title'))}
        </Text>
        <Text variant="muted">{body}</Text>
        {status === 'install' && installAsked ? (
          <Text variant="caption">{t('account.watch.installOpened')}</Text>
        ) : null}
        {here ? <WatchSyncLines state={here} now={now} /> : null}
      </View>
      {server && !serves ? (
        <Text variant="caption">{t('account.watch.serverCannot', { server: serverName })}</Text>
      ) : null}
      {status === 'install' && openInstall ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            icon="watch"
            title={t('account.watch.installOnWatch')}
            onPress={() => void install()}
          />
        </View>
      ) : null}
      {status !== 'install' ? (
        <View className="flex-row flex-wrap gap-2">
          {serves ? (
            <Button
              variant="outline"
              icon="watch"
              title={t(
                status === 'setup' || status === 'other-account'
                  ? watchWording(kind, 'account.watch.setUp')
                  : 'account.watch.sendAgain',
              )}
              loading={sending}
              onPress={() => void send()}
            />
          ) : null}
          <Button
            variant="ghost"
            icon="download"
            title={t('account.watch.booksLink')}
            onPress={() => openDownloads(connectionId)}
          />
        </View>
      ) : null}
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
