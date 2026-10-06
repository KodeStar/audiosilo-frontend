import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { GhostCovers } from '@/components/ui/ghost-art';

/** The Now card's place when nothing is in progress: ghost covers, one headline, one
 * sentence, one way into the Library. */
export function NowEmpty() {
  const { t } = useTranslation();
  const layout = useLayout();
  const phone = layout === 'phone';
  return (
    <View
      className={
        phone
          ? 'items-center gap-4 rounded-[22px] border border-border bg-card px-6 py-8'
          : cn(
              'flex-row items-center gap-8 rounded-sheet border border-border bg-card p-7',
              // Beside This week on a desktop: as tall as it.
              layout === 'desktop' && 'flex-1',
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

/** What went wrong with the listener's progress, and a way to try again. Shown in the
 * Now card's place only when nothing is on screen to keep. */
export function NowError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  const desktop = useLayout() === 'desktop';
  return (
    <View
      className={cn('gap-3 rounded-sheet border border-border bg-card p-6', desktop && 'flex-1')}
    >
      <Text variant="title">{t('home.error.title')}</Text>
      <Text variant="muted">{t('home.error.body')}</Text>
      <Button
        title={t('common.retry')}
        icon="rotate"
        variant="outline"
        onPress={onRetry}
        className="self-start"
      />
    </View>
  );
}
