import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { apiErrorKind, ApiError } from '@/api/client';
import {
  useDeleteUpcomingCalendar,
  useForgetCalendarLink,
  useMintUpcomingCalendar,
  useUpcomingCalendar,
  useUpcomingCalendarConnections,
  useUpcomingCalendarLink,
} from '@/api/hooks';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormError } from '@/components/ui/form-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { copyText } from '@/lib/clipboard';
import {
  type CalendarConnection,
  calendarRowState,
  canSubscribeWebcal,
  openWebcal,
} from '@/lib/upcoming-calendar';
import { cn } from '@/lib/utils';
import { useConnectionName } from '@/stores/session';

/**
 * "Add to your calendar" (Track U3), on the Upcoming page: a private calendar link per
 * server that a calendar app subscribes to (the releases coming up in the listener's
 * series, as all-day events). One row per connection whose server offers it
 * (`upcoming_calendar`) and whose user is not a kid (a kid is never asked); a demo account's
 * row says it can't, and asks nothing. Renders nothing where no server offers it.
 */
export function UpcomingCalendarCard() {
  const { t } = useTranslation();
  const rows = useUpcomingCalendarConnections();
  if (rows.length === 0) return null;
  return (
    <Card className="gap-4" testID="upcoming-calendar">
      <View className="gap-1">
        <Text variant="title" accessibilityRole="header">
          {t('upcoming.calendar.title')}
        </Text>
        <Text variant="muted">{t('upcoming.calendar.body')}</Text>
      </View>
      {rows.map((row, i) => (
        <CalendarRow key={row.id} row={row} named={rows.length > 1} first={i === 0} />
      ))}
    </Card>
  );
}

/** What a calendar link change that failed says: the caller's own words, never the
 * server's English. */
function calendarError(e: unknown, server: string, t: TFunction): string {
  const kind = apiErrorKind(e);
  if (kind === 'kid_account') return t('upcoming.calendar.kid');
  if (kind === 'demo_account') return t('upcoming.calendar.demo');
  return e instanceof ApiError
    ? t('upcoming.calendar.refused', { server })
    : t('upcoming.calendar.failed', { server });
}

/** A confirm the row is asking: Reset (a new link, the old one stops) or Turn off. */
type Asking = 'reset' | 'off' | null;

/** One connection's calendar link: its state (`calendarRowState`) and actions. */
function CalendarRow({
  row,
  named,
  first,
}: {
  row: CalendarConnection;
  /** More than one server has a row: each says which server it is. */
  named: boolean;
  first: boolean;
}) {
  const { t } = useTranslation();
  const server = useConnectionName(row.id);
  const status = useUpcomingCalendar(row.id, !row.demo);
  const stored = useUpcomingCalendarLink(row.id);
  const forget = useForgetCalendarLink(row.id);
  const mint = useMintUpcomingCalendar(row.id);
  const off = useDeleteUpcomingCalendar(row.id);
  const [asking, setAsking] = useState<Asking>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = calendarRowState({
    status: status.data,
    failed: status.isError || (status.isPaused && !status.data),
    stored: stored.isPending ? undefined : (stored.data ?? null),
  });
  const busy = mint.isPending || off.isPending;
  // A copy of a link turned off or replaced elsewhere is dead: this device forgets it. Not
  // while this row is changing the link itself (its status and copy are set one after the
  // other, and a copy between them is not stale).
  const forgetStale = state.staleCopy && !busy;
  useEffect(() => {
    if (forgetStale) void forget();
  }, [forgetStale, forget]);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setCopied(false);
    try {
      await action();
    } catch (e) {
      setError(calendarError(e, server, t));
    }
  };
  const confirm = () => {
    const what = asking;
    // Nothing asked (a second press on a dialog already closing): never a mint by default.
    if (!what) return;
    setAsking(null);
    void run(() => (what === 'off' ? off.mutateAsync(undefined) : mint.mutateAsync(undefined)));
  };

  let body: React.ReactNode;
  if (row.demo) {
    body = (
      <Text variant="muted" testID="upcoming-calendar-demo">
        {t('upcoming.calendar.demo')}
      </Text>
    );
  } else if (state.kind === 'loading') {
    body = (
      <Skeleton testID="upcoming-calendar-loading" className="h-[38px] w-48 rounded-control" />
    );
  } else if (state.kind === 'error') {
    body = (
      <View className="gap-2">
        <Text variant="muted">{t('upcoming.calendar.loadError', { server })}</Text>
        <Button
          variant="outline"
          icon="rotate"
          className="self-start"
          title={t('common.retry')}
          onPress={() => void status.refetch()}
        />
      </View>
    );
  } else if (state.kind === 'none') {
    body = (
      <Button
        variant="outline"
        icon="link"
        className="self-start"
        title={t('upcoming.calendar.get')}
        loading={mint.isPending}
        disabled={busy}
        onPress={() => void run(() => mint.mutateAsync(undefined))}
        testID="upcoming-calendar-get"
      />
    );
  } else {
    const shown = state.kind === 'shown' ? state.url : null;
    body = (
      <View className="gap-3">
        {shown ? (
          <>
            <Text
              selectable
              variant="mono"
              className="rounded-control bg-muted px-3 py-2.5"
              numberOfLines={3}
              testID="upcoming-calendar-url"
            >
              {shown}
            </Text>
            <Text variant="caption">{t('upcoming.calendar.private')}</Text>
            <Text variant="caption">{t('upcoming.calendar.publicNote')}</Text>
          </>
        ) : (
          <Text variant="muted" testID="upcoming-calendar-elsewhere">
            {t('upcoming.calendar.elsewhere')}
          </Text>
        )}
        <View className="flex-row flex-wrap gap-2">
          {shown ? (
            <>
              {canSubscribeWebcal() ? (
                <Button
                  icon="arrow-up-right"
                  title={t('upcoming.calendar.subscribe')}
                  disabled={busy}
                  onPress={() => void openWebcal(shown)}
                  testID="upcoming-calendar-subscribe"
                />
              ) : null}
              <Button
                variant="outline"
                icon={copied ? 'check' : 'copy'}
                title={copied ? t('common.copied') : t('upcoming.calendar.copy')}
                disabled={busy}
                onPress={() =>
                  void copyText(shown).then((ok) => {
                    if (ok) setCopied(true);
                  })
                }
                testID="upcoming-calendar-copy"
              />
            </>
          ) : null}
          <Button
            variant="outline"
            icon="rotate"
            title={t('upcoming.calendar.reset')}
            loading={mint.isPending}
            disabled={busy}
            onPress={() => setAsking('reset')}
            testID="upcoming-calendar-reset"
          />
          <Button
            variant="ghost"
            title={t('upcoming.calendar.turnOff')}
            loading={off.isPending}
            disabled={busy}
            onPress={() => setAsking('off')}
            testID="upcoming-calendar-off"
          />
        </View>
      </View>
    );
  }

  return (
    <View
      className={cn('gap-2', !first && 'border-t border-border pt-4')}
      testID="upcoming-calendar-row"
    >
      {named ? <Text variant="label">{server}</Text> : null}
      {body}
      <FormError error={error} testID="upcoming-calendar-error" />
      <ConfirmDialog
        visible={asking === 'reset'}
        title={t('upcoming.calendar.resetConfirm.title')}
        message={t('upcoming.calendar.resetConfirm.message')}
        confirmLabel={t('upcoming.calendar.reset')}
        confirmIcon="rotate"
        destructive
        onConfirm={confirm}
        onCancel={() => setAsking(null)}
      />
      <ConfirmDialog
        visible={asking === 'off'}
        title={t('upcoming.calendar.offConfirm.title')}
        message={t('upcoming.calendar.offConfirm.message')}
        confirmLabel={t('upcoming.calendar.turnOff')}
        destructive
        onConfirm={confirm}
        onCancel={() => setAsking(null)}
      />
    </View>
  );
}
