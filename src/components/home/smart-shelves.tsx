import { router } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';

import { type SmartShelf, smartShelfHref } from './home-model';

/** The card's title and its one quiet line. */
function shelfText(shelf: SmartShelf, t: TFunction): { title: string; sub: string } {
  switch (shelf.id) {
    case 'progress':
      return {
        title: t('home.smart.progress'),
        sub: t('home.smart.books', { count: shelf.count }),
      };
    case 'short':
      return { title: t('home.smart.short'), sub: t('home.smart.shortSub') };
    case 'narrator':
      return {
        title: t('home.smart.narrator', { name: shelf.name }),
        sub: t('home.smart.narratorSub', {
          count: shelf.books,
          duration: formatDuration(shelf.listened),
        }),
      };
    case 'added':
      return {
        title: t('home.smart.added'),
        sub:
          shelf.servers > 1
            ? t('home.smart.addedServers', { count: shelf.count, servers: shelf.servers })
            : t('home.smart.addedSub', { count: shelf.count }),
      };
  }
}

/**
 * Smart shelves: saved filters that keep themselves up to date (`smartShelves`), each a
 * card with a small fan of its covers, opening the Library filtered to match (the
 * narrator's shelf opens their page).
 */
export function SmartShelves({ shelves }: { shelves: readonly SmartShelf[] }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const layout = useLayout();
  const { openNarrator } = useOpen();
  const basis = layout === 'desktop' ? '22%' : '45%';
  return (
    <View className="flex-row flex-wrap gap-3">
      {shelves.map((shelf) => {
        const { title, sub } = shelfText(shelf, t);
        const open = () => {
          if (shelf.id === 'narrator') {
            openNarrator(shelf.connectionId, shelf.libraryId, shelf.name);
            return;
          }
          router.push(smartShelfHref(shelf));
        };
        return (
          <AnimatedPressable
            key={shelf.id}
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={`${title}, ${sub}`}
            style={{ flexBasis: basis, flexGrow: 1 }}
            className="relative min-h-[132px] justify-between gap-4 overflow-hidden rounded-[18px] border border-border bg-card p-4 hover:border-border-strong"
          >
            <View className="absolute -bottom-4 -right-1.5 flex-row" pointerEvents="none">
              {shelf.covers.map((c, i) => (
                <View
                  key={`${c.connectionId}:${c.libraryId}:${c.path}`}
                  style={{
                    marginLeft: i === 0 ? 0 : -34,
                    transform: [
                      { translateY: i === 1 ? -6 : 0 },
                      { rotate: `${(i - (shelf.covers.length - 1) / 2) * 9}deg` },
                    ],
                  }}
                >
                  <BookCover
                    connectionId={c.connectionId}
                    libraryId={c.libraryId}
                    path={c.path}
                    coverVersion={c.coverVersion}
                    width={layout === 'phone' ? 46 : 58}
                    title={c.title}
                    author={c.author}
                  />
                </View>
              ))}
            </View>
            <View className="gap-2" style={{ maxWidth: layout === 'phone' ? '100%' : '64%' }}>
              <View className="flex-row items-center gap-1">
                <Icon name="sparkles" size={11} color={themed.mutedForeground} />
                <Text variant="eyebrow" className="text-[10.5px]">
                  {t('home.smart.eyebrow')}
                </Text>
              </View>
              <Text className="font-display text-base leading-[20px] tracking-tight text-foreground">
                {title}
              </Text>
            </View>
            <Text variant="muted" className="text-[12.5px]" style={{ maxWidth: '55%' }}>
              {sub}
            </Text>
          </AnimatedPressable>
        );
      })}
    </View>
  );
}
