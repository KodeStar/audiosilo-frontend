import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatLongDate, formatRelative } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { linesFor, useLargeText } from '@/lib/text-scale';
import { useMinuteClock } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { greetingPart, type SyncPill } from './home-model';

const GREETING = {
  morning: { plain: 'home.greeting.morning', named: 'home.greeting.morningNamed' },
  afternoon: { plain: 'home.greeting.afternoon', named: 'home.greeting.afternoonNamed' },
  evening: { plain: 'home.greeting.evening', named: 'home.greeting.eveningNamed' },
} as const;

/** One of the greeting's pills: never wider than its row, its text cut to fit (a long
 * server name on a phone). */
function Pill({ children, label }: { children: ReactNode; label: string }) {
  // A min height: the words grow with the text size and may wrap under large text (at
  // iOS's AX sizes a fixed 30 cut them in half, fe#267); a wrapped pill rounds less.
  const large = useLargeText();
  return (
    <View
      accessible
      accessibilityLabel={label}
      testID="greeting-pill"
      className={cn(
        'min-h-[30px] max-w-full flex-row items-center gap-[7px] border border-border bg-card px-3 py-1',
        large ? 'rounded-2xl' : 'rounded-full',
      )}
    >
      {children}
    </View>
  );
}

/**
 * Home's greeting (STYLEGUIDE section 2): today's date, "Good evening, <name>." and the
 * truthful sync pill, plus how many servers Home gathers from when there is more than
 * one, or the one of them that is not answering (`down`, by name: never a green "2
 * servers" over a server that is down; frontend#131). A phone keeps its large "Home"
 * title (so back buttons stay named after it) and shows the date and the sync pill under
 * it, and the server that is down on a row of its own.
 */
export function Greeting({
  name,
  sync,
  servers,
  down,
}: {
  name: string | undefined;
  sync: SyncPill;
  servers: number;
  /** The name of a server that is not answering. */
  down?: string;
}) {
  const { t, i18n } = useTranslation();
  // Under large text the date and the pills stack, and their words wrap.
  const large = useLargeText();
  const lines = linesFor(1, large);
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  // Once a minute, so "synced 2 min ago" and the part of the day stay true.
  const minute = useMinuteClock();
  const now = new Date(minute);
  const date = formatLongDate(now);
  const part = greetingPart(now.getHours());
  const greeting = name ? t(GREETING[part].named, { name }) : t(GREETING[part].plain);

  const syncText =
    sync?.kind === 'local'
      ? sync.listens
        ? t('home.sync.listens', { count: sync.listens })
        : t('home.sync.local')
      : sync?.kind === 'synced'
        ? t(phone ? 'home.sync.syncedShort' : 'home.sync.synced', {
            when: formatRelative(sync.at, i18n.language || 'en', minute),
          })
        : null;
  const serversText = down
    ? t('shell.notAnswering', { name: down })
    : t('home.servers', { count: servers });
  const syncPill = syncText ? (
    <Pill label={syncText}>
      <Icon
        name={sync?.kind === 'local' ? 'hard-drive' : 'check'}
        size={14}
        color={sync?.kind === 'local' ? themed.warning : themed.success}
      />
      <Text
        className="shrink font-sans-semibold text-[12.5px] web:text-[0.78125rem] text-muted-foreground"
        numberOfLines={lines}
      >
        {syncText}
      </Text>
    </Pill>
  ) : null;
  const serversPill =
    servers > 1 ? (
      <Pill label={serversText}>
        <View className={`h-[7px] w-[7px] rounded-full ${down ? 'bg-warning' : 'bg-success'}`} />
        <Text
          className="shrink font-sans-semibold text-[12.5px] web:text-[0.78125rem] text-muted-foreground"
          numberOfLines={lines}
        >
          {serversText}
        </Text>
      </Pill>
    ) : null;

  if (phone) {
    // A phone row has no room for both pills beside the date: the server that is down
    // gets a row of its own under it (the healthy "2 servers" count stays desktop-only).
    return (
      <View className="gap-2">
        <View
          className={
            large ? 'items-start gap-2' : 'min-h-[30px] flex-row items-center justify-between gap-3'
          }
        >
          <Text variant="muted" className={large ? undefined : 'flex-1'} numberOfLines={lines}>
            {date}
          </Text>
          {syncPill}
        </View>
        {down && serversPill ? <View className="flex-row">{serversPill}</View> : null}
      </View>
    );
  }
  return (
    <View className="flex-row flex-wrap items-end justify-between gap-4">
      <View className="gap-2">
        <Text variant="eyebrow">{date}</Text>
        <Text
          variant="display"
          accessibilityRole="header"
          className="text-[38px] web:text-[2.375rem] leading-[42px] web:leading-[2.625rem]"
        >
          {greeting}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        {syncPill}
        {serversPill}
      </View>
    </View>
  );
}
