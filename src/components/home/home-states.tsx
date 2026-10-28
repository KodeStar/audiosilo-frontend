import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { GhostCovers } from '@/components/ui/ghost-art';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** The Now card's place when nothing is in progress: ghost covers, one headline, one
 * sentence, one way into the Library. `fill`: beside This week, as tall as it. */
export function NowEmpty({ fill = false }: { fill?: boolean }) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  return (
    <View
      className={
        phone
          ? 'items-center gap-4 rounded-[22px] border border-border bg-card px-6 py-8'
          : cn(
              'flex-row items-center gap-8 rounded-sheet border border-border bg-card p-7',
              fill && 'flex-1',
            )
      }
    >
      <GhostCovers size={70} />
      <View className={phone ? 'items-center gap-2' : 'flex-1 gap-2'}>
        <Text variant="heading" className={phone ? 'text-center' : undefined}>
          {t('home.empty.title')}
        </Text>
        <Text variant="muted" className={phone ? 'text-center' : undefined}>
          {t('home.empty.body')}
        </Text>
        <Button
          title={t('home.empty.action')}
          icon="library"
          onPress={() => router.navigate('/library')}
          className={phone ? 'mt-2 self-center' : 'mt-2 self-start'}
        />
      </View>
    </View>
  );
}

/** The Now card's place as a quiet notice: a title, a sentence, and an optional action
 * below. `fill` as for `NowEmpty`. */
function NowNotice({
  title,
  body,
  fill,
  testID,
  children,
}: {
  title: string;
  body: string;
  fill: boolean;
  testID?: string;
  children?: ReactNode;
}) {
  return (
    <View
      testID={testID}
      className={cn('gap-3 rounded-sheet border border-border bg-card p-6', fill && 'flex-1')}
    >
      <Text variant="title">{title}</Text>
      <Text variant="muted">{body}</Text>
      {children}
    </View>
  );
}

/** Offline before the listener's progress was read (paused, or failed when the network
 * went): where their place will show, and where the downloads are. `fill` as for
 * `NowEmpty`. */
export function NowOffline({ fill = false }: { fill?: boolean }) {
  const { t } = useTranslation();
  return (
    <NowNotice
      testID="home-offline"
      title={t('home.offline.title')}
      body={t('home.offline.body')}
      fill={fill}
    />
  );
}

/** What went wrong with the listener's progress, and a way to try again. Shown in the
 * Now card's place only when nothing is on screen to keep. `fill` as for `NowEmpty`. */
export function NowError({ onRetry, fill = false }: { onRetry: () => void; fill?: boolean }) {
  const { t } = useTranslation();
  return (
    <NowNotice title={t('home.error.title')} body={t('home.error.body')} fill={fill}>
      <Button
        title={t('common.retry')}
        icon="rotate"
        variant="outline"
        onPress={onRetry}
        className="self-start"
      />
    </NowNotice>
  );
}
