import { router } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ServerAddresses } from '@/api/types';
import { AddressesCard } from '@/components/layout/addresses-card';
import { leaveOnboarding } from '@/components/shell/leave-onboarding';
import { Button } from '@/components/ui/button';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';

import { joinList, type ReadyLine } from './connect-model';
import { ConnectFrame, StepDots } from './connect-frame';
import { ReadyShelf } from './ready-shelf';
import { type ReadyPlace, useReadySummary } from './use-ready-summary';

/**
 * The first run's last moment (STYLEGUIDE section 8, "Empty, skeleton, first run"):
 * "Your library is ready." Spines drop onto a plank, then the server, the library counts
 * and, when the listener already had a place on this server, where it came from. Start
 * listening goes Home; Browse the library opens the Library. Shown after the device's
 * first sign-in only (`finishConnect`).
 */
export function ReadyScreen({
  connectionId,
  name,
  addresses,
}: {
  connectionId: string;
  name: string;
  addresses?: ServerAddresses;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { line, failed, books, place } = useReadySummary(connectionId);
  const sentence = line ? lineText(line, name, t) : null;
  const placeText = place ? placeLine(place, t) : null;
  return (
    <ConnectFrame centered testID="ready-screen">
      <ReadyShelf books={books} phone={phone} />
      <StepDots step={2} />
      <View className="w-full items-center gap-2">
        <Text variant="eyebrow" className="text-center">
          {t('onboarding.ready.connected', { name })}
        </Text>
        <Text
          variant={phone ? 'display' : 'display-xl'}
          accessibilityRole="header"
          className="text-center"
        >
          {t('onboarding.ready.title')}
        </Text>
      </View>
      <View className="w-full max-w-[440px] items-center gap-1">
        {failed ? (
          <Text variant="muted" className="text-center">
            {t('onboarding.ready.loadError')}
          </Text>
        ) : sentence === null ? (
          <SkeletonText lines={2} className="w-full" />
        ) : (
          <Text variant="muted" className="text-center text-[15px] leading-[22px]">
            {sentence}
            {placeText ? ` ${placeText}` : ''}
          </Text>
        )}
      </View>
      {addresses?.home && addresses.away ? (
        <AddressesCard addresses={addresses} body={t('onboarding.addresses.body', { name })} />
      ) : null}
      <View className="w-full flex-row flex-wrap justify-center gap-2">
        <Button
          size="lg"
          icon="play"
          title={t('onboarding.ready.start')}
          onPress={leaveOnboarding}
        />
        <Button
          size="lg"
          variant="outline"
          title={t('onboarding.ready.browse')}
          onPress={() => router.dismissTo('/library')}
        />
      </View>
    </ConnectFrame>
  );
}

type T = TFunction;

function names(list: string[], t: T): string {
  return joinList(list, (rest, last) => String(t('onboarding.ready.and', { rest, last })));
}

/** The library sentence, in words. */
function lineText(line: ReadyLine, server: string, t: T): string {
  switch (line.kind) {
    case 'empty':
      return t('onboarding.ready.empty', { name: server });
    case 'booksIn':
      return t('onboarding.ready.booksIn', {
        count: line.books,
        books: formatCount(line.books),
        list: names(line.names, t),
      });
    case 'booksAcross':
      return t('onboarding.ready.booksAcross', {
        count: line.books,
        books: formatCount(line.books),
        libraries: line.libraries,
      });
    case 'librariesIn':
      return t('onboarding.ready.librariesIn', {
        count: line.libraries,
        list: names(line.names, t),
      });
    case 'librariesCount':
      return t('onboarding.ready.librariesCount', { count: line.libraries });
  }
}

/** "Your place in <book> came with you: chapter 23, 38% in." */
function placeLine(place: ReadyPlace, t: T): string {
  return place.chapter
    ? t('onboarding.ready.placeChapter', {
        title: place.title,
        chapter: place.chapter,
        percent: place.percent,
      })
    : t('onboarding.ready.place', { title: place.title, percent: place.percent });
}
