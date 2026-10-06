import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { Collection } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon, type IconName } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';
import { GhostCovers } from '@/components/ui/ghost-art';

import { BookCover } from '../book-cover';
import { nameList, type ShareLine, shareLine } from './collections-model';

/** Height of a card's cover stack for its width (the prototype's 1.45:1). */
const stackHeight = (width: number) => Math.round(width / 1.45);

/** A cover to fan on a card: its address and fallback text. */
type FanCover = {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  author?: string;
  coverVersion?: string;
};

/** Where each of up to three fanned covers sits: left edge (share of the width), tilt,
 * lift (share of the height); the middle one stands in front. */
const FAN = [
  { left: 0.08, rotate: -7, bottom: 0.1 },
  { left: 0.28, rotate: 0, bottom: 0.16 },
  { left: 0.48, rotate: 7, bottom: 0.1 },
];

/** Up to three covers fanned on a muted stand (decorative: the card names them); an
 * empty collection's stand holds dashed ghosts. */
export function CoverFan({ covers, width }: { covers: FanCover[]; width: number }) {
  const height = stackHeight(width);
  const size = Math.round(width * 0.44);
  return (
    <View
      style={{ height }}
      className="items-center justify-center overflow-hidden rounded-[18px] border border-border bg-muted"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {covers.length === 0 ? <GhostCovers /> : null}
      {covers.slice(0, 3).map((c, i) => {
        const at = FAN[covers.length === 1 ? 1 : i];
        return (
          <View
            key={`${c.libraryId}:${c.path}`}
            style={{
              position: 'absolute',
              left: width * at.left,
              bottom: height * at.bottom,
              zIndex: i === 1 ? 3 : 1,
              transform: [{ rotate: `${at.rotate}deg` }],
            }}
          >
            <BookCover
              connectionId={c.connectionId}
              libraryId={c.libraryId}
              path={c.path}
              coverVersion={c.coverVersion}
              width={size}
              title={c.title}
              author={c.author}
            />
          </View>
        );
      })}
    </View>
  );
}

/** "Shared with Sam" / "Shared with Sam, Maya and 2 more" / "Shared by Maya". */
export function useShareText() {
  const { t } = useTranslation();
  return (line: ShareLine): string => {
    if (!line) return '';
    if (line.kind === 'sharedBy') return t('library.collections.sharedBy', { name: line.name });
    const { names, more } = nameList(line.names);
    return more
      ? t('library.collections.sharedWithMore', { names, count: more })
      : t('library.collections.sharedWith', { names });
  };
}

/** A collection card's frame: the stand (`art`), then a title and one or two lines. */
export function CollectionCardFrame({
  width,
  art,
  title,
  lines,
  icon,
  onPress,
  accessibilityLabel,
}: {
  width: number;
  art: ReactNode;
  title: string;
  lines: string[];
  /** A glyph before the second line (`users` for a shared collection). */
  icon?: IconName;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, ...lines].filter(Boolean).join(', ')}
      style={{ width }}
      className={cn('gap-3.5 rounded-[18px]', Platform.select({ web: FOCUS_RING_CLASS }))}
    >
      {art}
      <View className="gap-0.5 px-0.5">
        <Text variant="title" className="text-base" numberOfLines={1}>
          {title}
        </Text>
        {lines.map((line, i) =>
          line ? (
            <View key={i} className="flex-row items-center gap-1.5">
              {i === 1 && icon ? (
                <Icon name={icon} size={13} color={themed.mutedForeground} />
              ) : null}
              <Text variant="caption" numberOfLines={2} className="flex-1">
                {line}
              </Text>
            </View>
          ) : null,
        )}
      </View>
    </AnimatedPressable>
  );
}

/** One collection (own or shared with the listener): its first covers, name, count and
 * who it's shared with or by. */
export function CollectionCard({
  connectionId,
  collection,
  width,
  onPress,
}: {
  connectionId: string;
  collection: Collection;
  width: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const shareText = useShareText();
  const share = shareLine(collection);
  return (
    <CollectionCardFrame
      width={width}
      onPress={onPress}
      title={collection.name}
      icon={share ? 'users' : undefined}
      lines={[
        t('library.collections.itemCount', { count: collection.item_count }),
        shareText(share),
      ]}
      art={
        <CoverFan
          width={width}
          covers={collection.preview.map((b) => ({
            connectionId,
            libraryId: b.library_id,
            path: b.rel_path,
            title: b.title,
            author: b.author,
            coverVersion: b.cover_version,
          }))}
        />
      }
    />
  );
}

/** "New collection": a dashed stand with a plus, and what collections are for. */
export function NewCollectionCard({ width, onPress }: { width: number; onPress: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <CollectionCardFrame
      width={width}
      onPress={onPress}
      title={t('library.collections.new')}
      lines={[t('library.collections.newHint')]}
      art={
        <View
          style={{ height: stackHeight(width) }}
          className="items-center justify-center gap-1.5 rounded-[18px] border-[1.5px] border-dashed border-border-strong"
        >
          <Icon name="plus" size={24} color={themed.mutedForeground} />
        </View>
      }
    />
  );
}

/** A loading card: the stand and two lines. */
export function CollectionCardSkeleton({ width }: { width: number }) {
  return (
    <View style={{ width }} className="gap-3.5">
      <View style={{ height: stackHeight(width) }}>
        <Skeleton className="h-full w-full rounded-[18px]" />
      </View>
      <View className="gap-1.5">
        <Skeleton className="h-4 w-2/3 rounded-sm" />
        <Skeleton className="h-3 w-1/3 rounded-sm" />
      </View>
    </View>
  );
}
