import type { TFunction } from 'i18next';
import { type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book } from '@/api/types';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useBookDragSource } from '@/components/upnext/drag-source';
import { useDownloadEntry } from '@/downloads/store';
import { useContextMenuRequest } from '@/lib/context-menu';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { percentOf, progressFractionRemaining } from '@/lib/progress-view';
import { ProgressBar } from '@/components/ui/progress-bar';
import { useSavedProgress } from '@/api/hooks';
import { useSession } from '@/stores/session';

import { BookCover } from './book-cover';
import { TileActions } from './tile-actions';

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
    out.push(t('covers.listened', { percent: percentOf(opts.progress) }));
  }
  if (opts.downloaded) out.push(t('covers.downloaded'));
  if (opts.server) out.push(t('covers.onServer', { server: opts.server }));
  return out;
}

/** A tile's friend-server flag: the connection's name when several servers are signed
 * in and it isn't the default one, else nothing (`CoverTile`'s `server`). */
export function useServerFlag(): (connectionId: string) => string | undefined {
  const connections = useSession((s) => s.connections);
  const defaultCid = useSession((s) => s.defaultConnectionId);
  return (cid) =>
    connections.length > 1 && cid !== defaultCid
      ? connections.find((c) => c.id === cid)?.name
      : undefined;
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
  /** 0..1 listened; drawn along the cover's bottom while in progress. With neither this
   * nor `finished` given, the tile reads the listener's saved progress itself. */
  progress?: number;
  finished?: boolean;
  /** A friend's (non-default) server it lives on: the "Maya" flag. */
  server?: string;
  /** Standing on a shelf ledge (`ShelfRow`): the titles hang below the ledge. */
  onShelf?: boolean;
  /** Defaults to opening the book page (in the current tab). */
  onPress?: () => void;
  /** The book's list row when the screen has it: the actions menu needs it, and
   * fetches it on first use otherwise. */
  book?: Book;
  className?: string;
};

/**
 * A book as a cover tile (STYLEGUIDE section 8 tiles, used by `ShelfRow` and
 * `CoverGrid`): the cover (`BookCover`), a progress bar along its bottom while in
 * progress (the listener's saved progress, read by the tile), flags in its corner (a friend's server, downloaded on this device - read from
 * the downloads registry -, finished), then the title (two lines) and one caption line.
 * The whole tile is one button whose name carries the title, caption and state. On the
 * web desktop the cover can be dragged onto Up next (`useBookDragSource`). A long-press
 * (and on the web a right-click, the Menu key or Shift+F10; for a screen reader the
 * "More actions" action) opens the book's actions (`TileActions`), so every screen's
 * tiles offer Up next, collections, downloads and finished without wiring of their own.
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
  progress: givenProgress,
  finished: givenFinished,
  server,
  onShelf,
  onPress,
  book,
  className,
}: CoverTileProps) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const downloaded = useDownloadEntry(connectionId, libraryId, path)?.status === 'downloaded';
  // The saved progress, unless the caller says (a screen that has it, or a live place).
  const own = givenProgress === undefined && givenFinished === undefined;
  const saved = useSavedProgress(libraryId, path, connectionId, own);
  const finished = own ? saved?.finished : givenFinished;
  const progress =
    own && saved
      ? progressFractionRemaining(saved.position, saved.duration || book?.duration || 0).fraction
      : givenProgress;
  // Web desktop: the cover drags onto Up next's drop zone.
  const coverRef = useRef<View>(null);
  useBookDragSource(coverRef, { connectionId, libraryId, path, title });
  // Each request bumps the count; the menu mounts on the first and reopens on each.
  const [request, setRequest] = useState(0);
  const onMenu = () => setRequest((n) => n + 1);
  const tileRef = useRef<View>(null);
  useContextMenuRequest(tileRef, onMenu);
  const inProgress = !finished && progress !== undefined && progress > 0 && progress < 1;
  const label = [title, caption, ...tileStateLabels({ progress, finished, downloaded, server, t })]
    .filter(Boolean)
    .join(', ');

  return (
    <AnimatedPressable
      onPress={onPress ?? (() => openBook(connectionId, libraryId, path))}
      ref={tileRef}
      onLongPress={onMenu}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityActions={[{ name: 'longpress', label: t('covers.moreActions') }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'longpress') onMenu();
      }}
      style={{ width }}
      className={cn('gap-2.5 rounded-cover', className)}
    >
      <View ref={coverRef}>
        <BookCover
          connectionId={connectionId}
          libraryId={libraryId}
          path={path}
          coverVersion={coverVersion}
          width={width}
          title={title}
          author={author}
        />
        {request > 0 ? (
          // Over the cover, so the menu's anchor sits in its corner.
          <View pointerEvents="box-none" className="absolute inset-0">
            <TileActions
              connectionId={connectionId}
              libraryId={libraryId}
              path={path}
              book={book}
              request={request}
              tileRef={tileRef}
            />
          </View>
        ) : null}
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
          <ProgressBar
            fraction={progress}
            className="absolute bottom-1.5 left-1.5 right-1.5 bg-white/35"
          />
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
