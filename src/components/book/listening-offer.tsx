import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapability } from '@/api/hooks';
import type { Chapter, Progress } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { describePlace, offerOf, type PlaceOffer } from '@/playback/place-reconcile';
import {
  ackVersion,
  getDeviceId,
  markAnswered,
  type ProgressSave,
  readMirror,
} from '@/playback/progress-sync';
import { tabularNums } from '@/theme/tabular-nums';

type Target = { connectionId: string; libraryId: number; path: string };

/**
 * Another device's place in this book to offer on the book page (Sync v2: `offerOf` over
 * the server's row, this device's acknowledged version and answered offers), measured from
 * `here` (where a press on the primary plays from), else null. Reads this device's id and
 * mirror once per row.
 */
export function useListeningOffer(
  target: Target,
  row: Progress | null | undefined,
  here: number | undefined,
): PlaceOffer | null {
  const [mine, setMine] = useState<{ deviceId: string; mirror: ProgressSave | null } | null>(null);
  const { connectionId, libraryId, path } = target;
  const version = row?.version;
  useEffect(() => {
    if (!row?.other_place && !row?.device_id) return;
    let live = true;
    void Promise.all([getDeviceId(), readMirror(connectionId, libraryId, path)])
      .then(([deviceId, mirror]) => live && setMine({ deviceId, mirror }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Read again when the row changes (a new version or other place).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, libraryId, path, version, row?.other_place?.updated_at]);
  if (!mine || !row) return null;
  const from = here ?? mine.mirror?.position ?? row.position;
  return offerOf(row, mine.deviceId, mine.mirror?.ack_version, from, mine.mirror?.answered);
}

/**
 * The book page's line under its actions when another device left this book somewhere
 * else (Sync v2): "On Chris's Watch: Chapter 12, 4:10 · Play from there". Playing from
 * there answers the offer (its row's version acknowledged, the place noted), so it is not
 * offered again; the player's toast offers the same place with Jump and Stay.
 */
export function ListeningOfferLine({
  target,
  row,
  here,
  chapters,
  onPlay,
}: {
  target: Target;
  row: Progress | null | undefined;
  here: number | undefined;
  chapters: Pick<Chapter, 'book_offset' | 'title'>[];
  onPlay: (position: number) => void;
}) {
  const { t } = useTranslation();
  // A Sync v2 offer: only a server with `listening_sync` keeps the other place.
  const synced = useCapability('listening_sync', target.connectionId) === true;
  const offer = useListeningOffer(target, synced ? row : null, here);
  const [answered, setAnswered] = useState<string | null>(null);
  if (!offer || !row || answered === offer.key) return null;
  const place = describePlace(chapters, offer.position, { bare: true });
  const play = () => {
    setAnswered(offer.key);
    const { connectionId, libraryId, path } = target;
    void ackVersion(connectionId, libraryId, path, row.version, row)
      .then(() => markAnswered(connectionId, libraryId, path, offer.key, row))
      .then(() => onPlay(offer.position));
  };
  return (
    <View testID="listening-offer" className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
      <Text variant="muted" style={tabularNums}>
        {offer.deviceName
          ? t('book.placeOffer.device', { device: offer.deviceName, place })
          : t('book.placeOffer.unknown', { place })}
      </Text>
      <Button
        variant="link"
        size="sm"
        title={t('book.placeOffer.play')}
        accessibilityLabel={t('book.placeOffer.playLabel', { place })}
        onPress={play}
      />
    </View>
  );
}
