import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useDownloadEntry } from '@/downloads/store';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';

import { BookCover } from './book-cover';

/** A flag chip on a tile's cover (downloaded, finished, a friend's server). */
function Flag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <View
      className={cn(
        'h-[22px] min-w-[22px] flex-row items-center justify-center gap-1 rounded-[7px] bg-black/65 px-1.5',
        className,
      )}
    >
      {children}
    </View>
  );
}

/** What a tile's state adds to its accessible name, in order. */
export function tileStateLabels(opts: {
  progress?: number;
  finished?: boolean;
  downloaded?: boolean;
  server?: string;
  t: TFunction;
}): string[] {
  const { t } = opts;
  const out: string[] = [];
  if (opts.finished) out.push(t('covers.finished'));
  else if (opts.progress !== undefined && opts.progress > 0) {
    out.push(t('covers.listened', { percent: Math.min(99, Math.round(opts.progress * 100)) }));
  }
  if (opts.downloaded) out.push(t('covers.downloaded'));
  if (opts.server) out.push(t('covers.onServer', { server: opts.server }));
  return out;
}

export type CoverTileProps = {
  connectionId: string;
  libraryId: number;
  path: string;
  title: string;
  /** The one line under the title (author by default at the call site, or "72% · 3h
   * left", "Added 2 days ago"). */
  caption?: string;
  /** For the cover's fallback text. */
  author?: string;
  coverVersion?: string;
  /** Tile width in points (the cover is square at this width). */
  width: number;
  /** 0..1 listened; drawn along the cover's bottom while in progress. */
  progress?: number;
  finished?: boolean;
  /** A friend's (non-default) server it lives on: the "Maya" flag. */
  server?: string;
  /** Standing on a shelf ledge (`ShelfRow`): the titles hang below the ledge. */
  onShelf?: boolean;
  /** Defaults to opening the book page (in the current tab). */
  onPress?: () => void;
  /** A secondary menu (long-press on touch). */
  onLongPress?: () => void;
  className?: string;
};

/**
 * A book as a cover tile (STYLEGUIDE section 8 tiles, used by `ShelfRow` and
 * `CoverGrid`): the cover (`BookCover`), a progress bar along its bottom while in
 * progress, flags in its corner (a friend's server, downloaded on this device - read from
 * the downloads registry -, finished), then the title (two lines) and one caption line.
 * The whole tile is one button whose name carries the title, caption and state.
 */
export function CoverTile({
  connectionId,
  libraryId,
  path,
  title,
  caption,
  author,
  coverVersion,
  width,
  progress,
  finished,
  server,
  onShelf,
  onPress,
  onLongPress,
  className,
}: CoverTileProps) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const downloaded = useDownloadEntry(connectionId, libraryId, path)?.status === 'downloaded';
  const inProgress = !finished && progress !== undefined && progress > 0 && progress < 1;
  const label = [title, caption, ...tileStateLabels({ progress, finished, downloaded, server, t })]
    .filter(Boolean)
    .join(', ');

  return (
    <AnimatedPressable
      onPress={onPress ?? (() => openBook(connectionId, libraryId, path))}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width }}
      className={cn('gap-2.5 rounded-[5px]', className)}
    >
      <View>
        <BookCover
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          coverVersion={coverVersion}
          width={width}
          title={title}
          author={author}
        />
        {server || downloaded || finished ? (
          <View className="absolute right-[7px] top-[7px] flex-row gap-1">
            {server ? (
              <Flag>
                <Icon name="server" size={11} color={colors.white} />
                <Text className="font-sans-bold text-[10.5px] text-white" numberOfLines={1}>
                  {server}
                </Text>
              </Flag>
            ) : null}
            {downloaded ? (
              <Flag>
                <Icon name="download" size={11} color={colors.white} />
              </Flag>
            ) : null}
            {finished ? (
              <Flag className="bg-success">
                <Icon name="check" size={11} color={colors.white} />
              </Flag>
            ) : null}
          </View>
        ) : null}
        {inProgress ? (
          <View className="absolute bottom-1.5 left-1.5 right-1.5 h-1 overflow-hidden rounded-full bg-white/35">
            <View
              className="h-full rounded-full bg-brand"
              style={{ width: `${progress * 100}%` }}
            />
          </View>
        ) : null}
      </View>
      <View className={cn('gap-0.5', onShelf && 'pt-3')}>
        <Text variant="label" numberOfLines={2}>
          {title}
        </Text>
        {caption ? (
          <Text variant="caption" numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
      </View>
    </AnimatedPressable>
  );
}
