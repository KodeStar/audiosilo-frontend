import { useIsFocused } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { HouseListeningRow } from '@/api/types';
import { HomeSection } from '@/components/home/home-section';
import { openHousehold } from '@/components/household/open-household';
import { BookCover } from '@/components/library/book-cover';
import { Portrait } from '@/components/series/portrait';
import { PressableRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { useToday } from '@/lib/use-day-label';
import type { Connection } from '@/stores/session';

import { HOUSE_GAP, houseCardWidth, houseCopy, houseRowKey } from './house-model';
import { useHouseRows } from './use-house-rows';

const AVATAR = 38;
const COVER = 46;

/**
 * Home's "Listening in the house" (STYLEGUIDE section 2, the prototype's Home row): one
 * section per connection whose server has `household`, where the listener shares and
 * someone else who shares listened in the last day. Renders nothing otherwise (loading,
 * an error, not sharing, nobody listening): it is an extra, never an empty section. Polls
 * only while Home is the focused screen.
 */
export function HouseRow({ connections }: { connections: readonly Connection[] }) {
  const focused = useIsFocused();
  return (
    <>
      {connections.map((c) => (
        <HouseSection key={c.id} connection={c} active={focused} />
      ))}
    </>
  );
}

function HouseSection({ connection, active }: { connection: Connection; active: boolean }) {
  const { t } = useTranslation();
  const rows = useHouseRows(connection.id, active);
  const layout = useLayout();
  const [width, setWidth] = useState(0);
  // "Earlier today" turns into "Yesterday" at midnight.
  const today = useToday();
  if (rows.length === 0) return null;

  const cardWidth = houseCardWidth(width, layout);
  return (
    <HomeSection
      title={t('house.title')}
      sub={t('house.sub', { server: connection.name })}
      action={{ label: t('house.settingsLink'), onPress: openHousehold }}
    >
      <View
        testID={`house-row-${connection.id}`}
        accessibilityRole="list"
        accessibilityLabel={t('house.listLabel', { server: connection.name })}
        className="flex-row flex-wrap"
        style={{ gap: HOUSE_GAP }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {rows.map((r) => (
          <View
            key={houseRowKey(r)}
            testID="house-card-slot"
            style={{ width: cardWidth ?? '100%' }}
          >
            <HouseCard connectionId={connection.id} row={r} today={today} />
          </View>
        ))}
      </View>
    </HomeSection>
  );
}

/** One housemate: their avatar and name, the book's title and state line, its cover.
 * Tapping opens the book's page on this connection. */
function HouseCard({
  connectionId,
  row,
  today,
}: {
  connectionId: string;
  row: HouseListeningRow;
  today: number;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const copy = houseCopy(row, today, t);
  return (
    <PressableRow
      testID="house-card"
      accessibilityRole="button"
      accessibilityLabel={copy.label}
      onPress={() => openBook(connectionId, row.library_id, row.path)}
      className="min-h-[62px] flex-row items-center gap-3 rounded-card py-3 pl-3 pr-3.5"
    >
      <Portrait name={row.username} kind="user" size={AVATAR} />
      <View className="min-w-0 flex-1 gap-px">
        <View className="flex-row items-center gap-1.5">
          <Text variant="label" numberOfLines={1} className="shrink">
            {row.username}
          </Text>
          {/* Status is an icon and a word: the dot sits beside "Listening now". */}
          {row.state === 'playing' ? (
            <View testID="house-live-dot" className="h-[7px] w-[7px] rounded-full bg-success" />
          ) : null}
        </View>
        <Text numberOfLines={1} className="text-sm">
          {copy.title}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {copy.line}
        </Text>
      </View>
      <BookCover
        connectionId={connectionId}
        libraryId={row.library_id}
        path={row.path}
        width={COVER}
        title={copy.title}
        author={row.author ?? undefined}
      />
    </PressableRow>
  );
}
