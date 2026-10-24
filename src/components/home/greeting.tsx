import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatLongDate, formatRelative } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';

import { greetingPart, type SyncPill } from './home-model';

const GREETING = {
  morning: { plain: 'home.greeting.morning', named: 'home.greeting.morningNamed' },
  afternoon: { plain: 'home.greeting.afternoon', named: 'home.greeting.afternoonNamed' },
  evening: { plain: 'home.greeting.evening', named: 'home.greeting.eveningNamed' },
} as const;

/** Re-render once a minute, so "synced 2 min ago" and the part of the day stay true. */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Pill({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      className="h-[30px] flex-row items-center gap-[7px] rounded-full border border-border bg-card px-3"
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
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  const now = useMinuteClock();
  const date = formatLongDate(now);
  const part = greetingPart(now.getHours());
  const greeting = name ? t(GREETING[part].named, { name }) : t(GREETING[part].plain);

  const syncText =
    sync?.kind === 'local'
      ? t('home.sync.local')
      : sync?.kind === 'synced'
        ? t(phone ? 'home.sync.syncedShort' : 'home.sync.synced', {
            when: formatRelative(sync.at),
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
      <Text className="font-sans-semibold text-[12.5px] text-muted-foreground" numberOfLines={1}>
        {syncText}
      </Text>
    </Pill>
  ) : null;
  const serversPill =
    servers > 1 ? (
      <Pill label={serversText}>
        <View className={`h-[7px] w-[7px] rounded-full ${down ? 'bg-warning' : 'bg-success'}`} />
        <Text className="font-sans-semibold text-[12.5px] text-muted-foreground" numberOfLines={1}>
          {serversText}
        </Text>
      </Pill>
    ) : null;

  if (phone) {
    // A phone row has no room for both pills beside the date: the server that is down
    // gets a row of its own under it (the healthy "2 servers" count stays desktop-only).
    return (
      <View className="gap-2">
        <View className="min-h-[30px] flex-row items-center justify-between gap-3">
          <Text variant="muted" className="flex-1" numberOfLines={1}>
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
        <Text variant="display" accessibilityRole="header" className="text-[38px] leading-[42px]">
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
