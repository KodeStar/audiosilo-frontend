import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { resolveAccountCid } from '@/components/account/account-model';
import { BookCover } from '@/components/library/book-cover';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Notice } from '@/components/ui/notice';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { pushInShell } from '@/lib/open';
import { accountHref } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useProfileConnections } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { removeFromWatch, sendBookToWatch } from '@/watch/send';
import { useWatchStatus, watchErrorText } from '@/watch/use-watch';
import { forgetRow, ledgerRows, useWatchLedger } from '@/watch/watch-ledger';
import {
  watchAccountOf,
  type WatchCardStatus,
  watchCardStatus,
  watchSectionVisible,
} from '@/watch/watch-model';
import { rowActions, type WatchRow, type WatchRowPhase, watchRows } from '@/watch/watch-rows';
import { useWatchStore } from '@/watch/watch-store';

import { COVER, RowAction, RowFrame, SectionHead, sizeMeta } from './download-rows';

/** Whose books the section shows: the connection named by a link here (the Send to watch toast, the
 * account card) while the person holds it, else their default one. */
function useSectionConnection(): Connection | null {
  const { watch } = useRouteParams<{ watch?: string }>();
  const connections = useProfileConnections();
  const defaultId = useSession((s) => s.defaultConnectionId);
  const id = resolveAccountCid(
    undefined,
    typeof watch === 'string' ? watch : null,
    connections.map((c) => c.id),
    defaultId,
  );
  return connections.find((c) => c.id === id) ?? null;
}

/**
 * The Downloads page's "On your Apple Watch" (iOS, with the app on a paired watch; never a kid's or
 * a demo's account): what the phone sent, and what the watch says it holds, for one account on this
 * watch. Rules in `src/watch/watch-rows.ts`. `onReveal` scrolls the page to it, once, when a link
 * brought the listener here.
 */
export function WatchSection({ onReveal }: { onReveal: (y: number) => void }) {
  const { t } = useTranslation();
  const watch = useWatchStatus();
  const connection = useSectionConnection();
  const { watch: linked } = useRouteParams<{ watch?: string }>();
  const pairUntil = useWatchStore((s) => (connection ? s.pairUntil[connection.id] : undefined));
  const ledger = useWatchLedger((s) => s.ledger);
  const visible = !!connection && watchSectionVisible(watch, connection.user);
  // A sent row stops claiming progress after 7 days, with nothing else to say so.
  const now = useNow(60_000, visible);
  const [removing, setRemoving] = useState<WatchRow | null>(null);
  const [y, setY] = useState<number | null>(null);
  const revealed = useRef<unknown>(undefined);

  useEffect(() => {
    if (!linked || y === null || revealed.current === linked) return;
    revealed.current = linked;
    onReveal(y);
  }, [linked, y, onReveal]);

  if (!connection || !visible) return null;

  const account = watchAccountOf(connection);
  const rows = watchRows(ledgerRows(ledger, watch.watchId, account), account, watch, now);
  const status = watchCardStatus(watch, connection, pairUntil, now);
  const server = connection.name;

  return (
    <View className="gap-3" testID="downloads-watch" onLayout={(e) => setY(e.nativeEvent.layout.y)}>
      <SectionHead
        title={t('downloads.watch.title')}
        sub={rows.length > 0 ? formatCount(rows.length) : undefined}
      />
      {status === 'signed-in' ? null : <WatchAway status={status} connection={connection} />}
      {rows.length > 0 ? (
        <Card className="overflow-hidden p-0">
          {rows.map((row, i) => (
            <WatchBookRow
              key={`${row.library_id}:${row.path}`}
              row={row}
              connection={connection}
              server={server}
              first={i === 0}
              onRemove={() => setRemoving(row)}
            />
          ))}
        </Card>
      ) : status === 'signed-in' ? (
        <Text variant="muted">{t('downloads.watch.empty')}</Text>
      ) : null}
      <ConfirmDialog
        visible={!!removing}
        title={t('downloads.watch.remove.title')}
        message={removing ? t('downloads.watch.remove.message', { title: removing.title }) : ''}
        confirmLabel={t('downloads.watch.remove.confirm')}
        confirmIcon="trash"
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            removeFromWatch(connection, removing.library_id, removing).catch((e: unknown) =>
              toast({ title: watchErrorText(e, server, t) }),
            );
          }
          setRemoving(null);
        }}
      />
    </View>
  );
}

/** Why the list is not the watch's: it is not signed in to this account. Rows sent for this account
 * can still show under it (held on the watch), but never the other account's books. */
function WatchAway({ status, connection }: { status: WatchCardStatus; connection: Connection }) {
  const { t } = useTranslation();
  const server = connection.name;
  const body =
    status === 'other-account'
      ? t('downloads.watch.otherAccount', { server })
      : status === 'sent'
        ? t('account.watch.sent')
        : status === 'expired'
          ? t('account.watch.expired')
          : t('downloads.watch.signedOut', { server });
  return (
    <View className="gap-2">
      <Notice icon="watch" title={t('downloads.watch.notHere')} body={body} />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        title={t('downloads.watch.openAccount')}
        onPress={() => pushInShell(accountHref(connection.id))}
      />
    </View>
  );
}

/** Phases worth a second look, in the page's own warning and destructive colours. */
const PHASE_TONE: Partial<Record<WatchRowPhase, string>> = {
  failed: 'text-destructive',
  'send-failed': 'text-destructive',
  'remove-failed': 'text-destructive',
  stale: 'text-warning',
  'remove-refused': 'text-warning',
};

function WatchBookRow({
  row,
  connection,
  server,
  first,
  onRemove,
}: {
  row: WatchRow;
  connection: Connection;
  server: string;
  first: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const api = useOptionalApi(connection.id);
  const actions = rowActions(row.phase);
  const sendAgain = () => {
    if (!api) return;
    sendBookToWatch(api, connection, row.library_id, {
      rel_path: row.path,
      title: row.title,
      author: row.author ?? '',
    }).catch((e: unknown) => toast({ title: watchErrorText(e, server, t) }));
  };
  const forget = () => {
    const account = watchAccountOf(connection);
    const { watchId } = useWatchStore.getState().status;
    if (watchId) forgetRow(watchId, account, row);
  };
  return (
    <RowFrame
      first={first}
      cover={
        <BookCover
          connectionId={connection.id}
          libraryId={row.library_id}
          path={row.path}
          width={COVER}
          title={row.title}
        />
      }
      title={row.title}
      meta={sizeMeta(t, server, row.phase === 'ready' ? (row.bytes ?? 0) : 0, false)}
      status={
        <Text variant="caption" className={cn(PHASE_TONE[row.phase])}>
          {t(`downloads.watch.phase.${row.phase}`)}
        </Text>
      }
      actions={
        <>
          {actions.sendAgain && api ? (
            <RowAction
              variant="outline"
              icon="rotate"
              withIcon
              iconOnly={phone}
              title={t('downloads.watch.sendAgain')}
              accessibilityLabel={t('downloads.watch.sendAgainLabel', { title: row.title })}
              onPress={sendAgain}
            />
          ) : null}
          {actions.remove ? (
            <RowAction
              variant="ghost"
              icon="trash"
              iconOnly={phone || actions.sendAgain}
              title={t('downloads.watch.remove.confirm')}
              accessibilityLabel={t('downloads.watch.removeLabel', { title: row.title })}
              onPress={onRemove}
            />
          ) : null}
          {actions.dismiss ? (
            <RowAction
              variant="ghost"
              icon="close"
              iconOnly={phone}
              title={t('downloads.watch.dismiss')}
              accessibilityLabel={t('downloads.watch.dismissLabel', { title: row.title })}
              onPress={forget}
            />
          ) : null}
        </>
      }
    />
  );
}
