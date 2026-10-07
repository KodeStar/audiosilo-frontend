import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { ConnectionScope, useOptionalApi } from '@/api/provider';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { HistorySection } from '@/components/library/history-section';
import { NotesSection } from '@/components/library/notes-section';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectBookPosition, usePlayer } from '@/playback/store';

import { addBookmarkHere } from '../player-shortcuts';
import { usePlayingTarget } from '../playing-target';
import type { PlayTarget } from '../use-play-book';
import { ChaptersPanel } from './chapters-panel';
import {
  activeCompanionTab,
  COMPANION_TAB_LABEL,
  type CompanionTab,
  companionTabs,
} from './companion-model';
import { useCompanion } from './companion-store';
import { StoryPanel } from './story-panel';
import { type CompanionData, useCompanionData } from './use-companion-data';
import { WhoPanel } from './who-panel';

/** Where the companion sits: the desktop's 420 column and the phone's sheet scroll on
 * their own; the tablet's sits inline in the player's page and lets the page scroll. */
export type CompanionVariant = 'column' | 'sheet' | 'inline';

/** "Add bookmark at 1:16:19", in whole seconds: its own leaf, the one piece of the
 * Bookmarks tab that follows the playhead (the list above it never redraws per tick).
 * Busy while the bookmark is on its way (`addBookmarkHere` adds one at a time). */
function AddBookmarkHere() {
  const { t } = useTranslation();
  const at = usePlayer((s) => Math.floor(selectBookPosition(s)));
  const [adding, setAdding] = useState(false);
  const add = () => {
    setAdding(true);
    void addBookmarkHere(t).finally(() => setAdding(false));
  };
  return (
    <Button
      title={t('player.bookmarks.addAt', { time: formatClock(at) })}
      icon="bookmark"
      loading={adding}
      onPress={add}
    />
  );
}

/** Bookmarks, Notes and History: the listener's own, on the book's server. A downloaded
 * book can play on with that connection gone (removed, or its token failed to load), and
 * those sections need it: say so instead of asking. */
function OwnPanel({ tab, target }: { tab: 'bookmarks' | 'notes' | 'history'; target: PlayTarget }) {
  const { connectionId } = target;
  const { t } = useTranslation();
  const api = useOptionalApi(connectionId);
  if (!api) {
    return (
      <EmptyState
        icon="server"
        title={t('player.companion.noServerTitle')}
        hint={t('player.companion.noServerHint')}
      />
    );
  }
  return <OwnSection tab={tab} target={target} />;
}

function OwnSection({
  tab,
  target,
}: {
  tab: 'bookmarks' | 'notes' | 'history';
  target: PlayTarget;
}) {
  const { t } = useTranslation();
  const seekBook = usePlayer((s) => s.seekBook);
  const chapters = usePlayer((s) => s.nowPlaying?.queue.chapters);
  const onJump = (p: number) => void seekBook(p);
  const { connectionId, libraryId, path } = target;
  if (tab === 'bookmarks')
    return (
      <BookmarksSection
        libraryId={libraryId}
        path={path}
        connectionId={connectionId}
        emptyLabel={t('player.bookmarks.empty')}
        addButton={<AddBookmarkHere />}
        onJump={onJump}
      />
    );
  if (tab === 'notes')
    return <NotesSection libraryId={libraryId} path={path} connectionId={connectionId} />;
  return (
    <HistorySection
      libraryId={libraryId}
      path={path}
      connectionId={connectionId}
      emptyLabel={t('player.history.empty')}
      chapters={chapters}
      onJump={onJump}
    />
  );
}

function Panel({
  tab,
  data,
  onChapter,
}: {
  tab: CompanionTab;
  data: CompanionData;
  onChapter?: () => void;
}) {
  switch (tab) {
    case 'who':
      return <WhoPanel data={data} />;
    case 'story':
      return <StoryPanel data={data} />;
    case 'chapters':
      return <ChaptersPanel onSelected={onChapter} />;
    default:
      return <OwnPanel tab={tab} target={data.target} />;
  }
}

function CompanionBody({
  target,
  variant,
  onChapter,
}: {
  target: PlayTarget;
  variant: CompanionVariant;
  onChapter?: () => void;
}) {
  const { t } = useTranslation();
  const data = useCompanionData(target);
  const tabs = companionTabs(data.status !== 'off');
  const wanted = useCompanion((s) => s.tab);
  const setTab = useCompanion((s) => s.setTab);
  const tab = activeCompanionTab(tabs, wanted);
  const scrolls = variant !== 'inline';
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as CompanionTab)}
      className={cn(scrolls && 'flex-1')}
    >
      <TabsList scrollable className={variant === 'column' ? 'px-5' : undefined}>
        {tabs.map((v) => (
          <TabsTrigger key={v} value={v} testID={`companion-tab-${v}`}>
            <Text>{t(COMPANION_TAB_LABEL[v])}</Text>
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={tab} className={cn(scrolls && 'flex-1')}>
        {tab === 'chapters' && scrolls ? (
          // The list is its own (virtualized) scroller, opened on the current chapter.
          <View className="flex-1 px-2 pt-2">
            <ChaptersPanel virtualized onSelected={onChapter} />
          </View>
        ) : scrolls ? (
          <ScrollView
            className="flex-1"
            contentContainerClassName={variant === 'column' ? 'px-5 py-4' : 'px-1 py-4'}
            keyboardShouldPersistTaps="handled"
          >
            <Panel tab={tab} data={data} onChapter={onChapter} />
          </ScrollView>
        ) : (
          <View className="py-4">
            <Panel tab={tab} data={data} onChapter={onChapter} />
          </View>
        )}
      </TabsContent>
    </Tabs>
  );
}

/**
 * The full player's companion (STYLEGUIDE section 8, "Full player" and "Companion"):
 * Who's who, Story so far, Chapters, Bookmarks, Notes and History for the PLAYING book,
 * against that book's own server. The community tabs only where the server has
 * `metadata`. Which tab is open lives in `useCompanion`, so every surface agrees.
 */
export function Companion({
  variant,
  onChapter,
  className,
}: {
  variant: CompanionVariant;
  /** After a chapter tap (the phone's sheet closes). */
  onChapter?: () => void;
  className?: string;
}) {
  const target = usePlayingTarget();
  if (!target) return null;
  return (
    <View className={cn(variant !== 'inline' && 'flex-1', className)}>
      <ConnectionScope connectionId={target.connectionId}>
        <CompanionBody target={target} variant={variant} onChapter={onChapter} />
      </ConnectionScope>
    </View>
  );
}
