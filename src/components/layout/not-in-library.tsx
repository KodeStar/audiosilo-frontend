import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Back where there is somewhere to go back to, else Home (a cold link). `dismissTo`, never
 * `replace`: `(app)` is the root stack's anchor and already sits under a modal. */
export function backOrHome() {
  if (router.canGoBack()) router.back();
  else router.dismissTo('/');
}

/**
 * A page whose content isn't in the library (CONNECT-13, CONNECT-03): a link to a book or
 * folder that was moved or removed, a library this account can't see, a mistyped link.
 * One heading, one sentence, and the ways out: Back (Close in a modal) and Home. `kind`
 * picks the words: `book`, `folder`, or `nothing` for the player opened with no book
 * while none is loaded.
 */
export function NotInLibraryState({
  kind = 'book',
  modal = false,
  className,
}: {
  kind?: 'book' | 'folder' | 'nothing';
  /** In a root modal (the player): the first action reads Close. */
  modal?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const icon: IconName = kind === 'nothing' ? 'play' : kind === 'folder' ? 'folder' : 'book';
  return (
    <View
      testID={`not-in-library-${kind}`}
      className={cn('flex-1 items-center justify-center gap-3 px-6 py-12', className)}
    >
      <Icon name={icon} size={40} color={themed.mutedForeground} />
      <Text variant="title" className="text-center" accessibilityRole="header">
        {t(`common.notInLibrary.${kind}.title`)}
      </Text>
      <Text variant="muted" className="max-w-[440px] text-center">
        {t(`common.notInLibrary.${kind}.body`)}
      </Text>
      <View className="mt-2 flex-row flex-wrap justify-center gap-3">
        <Button
          variant="secondary"
          title={modal ? t('common.close') : t('common.notInLibrary.back')}
          onPress={backOrHome}
        />
        <Button
          variant="secondary"
          title={t('common.notFound.home')}
          icon="home"
          onPress={() => router.dismissTo('/')}
        />
      </View>
    </View>
  );
}
