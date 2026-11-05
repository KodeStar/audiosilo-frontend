import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormError } from '@/components/ui/form-error';
import { Text } from '@/components/ui/text';
import { formatBytes, formatRelative } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { setUpWatch } from '@/watch/send';
import { useWatchStatus, watchErrorText } from '@/watch/use-watch';
import {
  serverServesWatch,
  type WatchBook,
  type WatchState,
  watchCardStatus,
  watchCardVisible,
} from '@/watch/watch-model';
import { useWatchStore } from '@/watch/watch-store';

/**
 * The account page's "Apple Watch" card, for a phone with a paired watch and an account that can
 * use one (never a kid's or a demo's): Set up signs the watch in to this server with no typing
 * (a `pair` message), Send again does it once more. Once the watch says it is signed in here,
 * who as, the books on it, the listening it still has to send and when it last synced.
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
      {here ? <WatchBooks books={here.books} /> : null}
      {server && !serves ? (
        <Text variant="caption">{t('account.watch.serverCannot', { server: serverName })}</Text>
      ) : null}
      {status !== 'install' && serves ? (
        <Button
          variant="outline"
          icon="watch"
          className="self-start"
          title={t(
            status === 'setup' || status === 'other-account'
              ? 'account.watch.setUp'
              : 'account.watch.sendAgain',
          )}
          loading={sending}
          onPress={() => void send()}
        />
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
      ) : state.last_sync_at ? (
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

function WatchBooks({ books }: { books: WatchBook[] }) {
  const { t } = useTranslation();
  if (books.length === 0) return <Text variant="caption">{t('account.watch.noBooks')}</Text>;
  return (
    <View className="gap-2">
      <Text variant="label">{t('account.watch.booksTitle')}</Text>
      <View className="overflow-hidden rounded-card border border-border">
        {books.map((book, i) => (
          <WatchBookRow key={`${book.library_id}:${book.path}`} book={book} first={i === 0} />
        ))}
      </View>
    </View>
  );
}

/** One book on the watch: its title, and where its download is (its size once it is there). */
function WatchBookRow({ book, first }: { book: WatchBook; first: boolean }) {
  const { t } = useTranslation();
  return (
    <View
      className={cn('flex-row items-center gap-3 px-4 py-3', !first && 'border-t border-border')}
    >
      <Text className="min-w-0 flex-1 text-[13px]" numberOfLines={2}>
        {book.title}
      </Text>
      <Text variant="caption" style={tabularNums}>
        {book.state === 'ready' && book.bytes !== undefined
          ? formatBytes(book.bytes)
          : t(`account.watch.bookState.${book.state}`)}
      </Text>
    </View>
  );
}
