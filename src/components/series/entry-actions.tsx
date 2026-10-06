import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueueButton } from '@/components/library/queue-button';
import { useQueueActions } from '@/components/library/use-queue-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useOpen } from '@/lib/open';
import { openExternalUrl } from '@/lib/support';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';
import { usePlayBook } from '@/components/player/use-play-book';
import { percentOf } from '@/lib/progress-view';

import type { SeriesEntry } from './series-model';

/**
 * What an entry's status and action are, shared by the shelf's caption and the entry
 * list so the two can never disagree. One action per entry (STYLEGUIDE: "the one right
 * action"): resume the book you're on; queue (or, without Up next, play) an unread book
 * you own; open a finished one; listen to a copy on another server; or, for a book on
 * no server, look it up on AudioSilo Meta.
 */
export type EntryAction =
  | { kind: 'resume' }
  | { kind: 'queue' }
  | { kind: 'play' }
  | { kind: 'open' }
  | { kind: 'elsewhere'; server: string }
  | { kind: 'meta'; url: string }
  | { kind: 'none' };

export function entryAction(entry: SeriesEntry, queueSupported: boolean): EntryAction {
  if (entry.kind === 'ghost') return entry.webUrl ? { kind: 'meta', url: entry.webUrl } : NONE;
  if (entry.kind === 'elsewhere') {
    return { kind: 'elsewhere', server: entry.copy.connectionName };
  }
  if (entry.finished) return { kind: 'open' };
  if (entry.started) return { kind: 'resume' };
  return queueSupported ? { kind: 'queue' } : { kind: 'play' };
}

const NONE: EntryAction = { kind: 'none' };

/** The status badge of an entry: status is always an icon or word, never colour alone. */
export function EntryBadge({ entry, current }: { entry: SeriesEntry; current: boolean }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  if (current) {
    return (
      <Badge variant="brand">
        <Text style={tabularNums}>
          {t('series.listening', { percent: percentOf(entry.fraction) })}
        </Text>
      </Badge>
    );
  }
  if (entry.finished) {
    return (
      <Badge variant="success">
        <Icon name="check" size={12} color={themed.success} />
        <Text>{t('covers.finished')}</Text>
      </Badge>
    );
  }
  if (entry.kind === 'elsewhere') {
    return (
      <Badge variant="info">
        <Icon name="server" size={12} color={themed.info} />
        <Text>{t('covers.onServer', { server: entry.copy.connectionName })}</Text>
      </Badge>
    );
  }
  if (entry.kind === 'owned') {
    return (
      <Badge>
        <Text>{t('covers.onServer', { server: entry.copy.connectionName })}</Text>
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <Text>{t('covers.notInLibrary')}</Text>
    </Badge>
  );
}

/**
 * An entry's one action as a button. `compact` is the entry list's small form ("Resume",
 * "Queue it", "Open on Maya's Shelf"); the shelf's caption names more ("Resume chapter
 * 23", "Listen on Maya's Shelf") and adds "Details" beside "Queue it".
 */
export function EntryActionButton({
  entry,
  compact,
  resumeChapter,
}: {
  entry: SeriesEntry;
  compact?: boolean;
  /** The chapter the book you're on resumes at, when known. */
  resumeChapter?: number;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openBook } = useOpen();
  const play = usePlayBook();
  const start = () =>
    copy && void play(copy).catch(() => toast({ title: t('library.bookActions.playFailed') }));
  const copy = entry.copy;
  // Only an owned book is queued (on this page's server); a copy on another server
  // opens there, so its Up next is never asked for.
  const q = useQueueActions(entry.kind === 'owned' ? copy?.connectionId : undefined);
  const action = entryAction(entry, q.supported);
  const size = compact ? 'sm' : 'default';
  // The visible words first, then which book (a list of these buttons reads apart).
  const named = (label: string) => [label, entry.title].filter(Boolean).join(', ');
  const open = () => copy && openBook(copy.connectionId, copy.libraryId, copy.path);

  switch (action.kind) {
    case 'resume':
      const label =
        resumeChapter && !compact
          ? t('series.resumeChapter', { chapter: resumeChapter })
          : t('series.resume');
      return (
        <Button
          size={size}
          icon="play"
          title={label}
          accessibilityLabel={named(label)}
          onPress={start}
        />
      );
    case 'play':
      return (
        <Button
          size={size}
          variant={compact ? 'outline' : 'default'}
          icon="play"
          title={t('series.play')}
          accessibilityLabel={named(t('series.play'))}
          onPress={start}
        />
      );
    case 'queue': {
      if (!copy) return null;
      const button = (
        <QueueButton
          connectionId={copy.connectionId}
          libraryId={copy.libraryId}
          path={copy.path}
          title={entry.title}
          size={size}
          variant={compact ? 'outline' : 'default'}
        />
      );
      if (compact) return button;
      return (
        <View className="flex-row flex-wrap gap-2">
          {button}
          <Button
            variant="outline"
            title={t('series.details')}
            accessibilityLabel={named(t('series.details'))}
            onPress={open}
          />
        </View>
      );
    }
    case 'open':
      return compact ? (
        <View className="flex-row items-center gap-1.5 px-1">
          <Icon name="circle-check" size={15} color={themed.success} />
          <Text variant="label" className="text-success">
            {t('covers.finished')}
          </Text>
        </View>
      ) : (
        <Button variant="outline" icon="book-open" title={t('series.open')} onPress={open} />
      );
    case 'elsewhere':
      return (
        <Button
          size={size}
          variant="outline"
          icon="server"
          title={
            compact
              ? t('series.openOn', { server: action.server })
              : t('series.listenOn', { server: action.server })
          }
          onPress={open}
        />
      );
    case 'meta':
      return (
        <Button
          size={size}
          variant={compact ? 'ghost' : 'outline'}
          icon="arrow-up-right"
          title={t('series.viewOnMeta')}
          role="link"
          accessibilityLabel={named(t('series.viewOnMeta'))}
          onPress={() => void openExternalUrl(action.url)}
        />
      );
    default:
      return null;
  }
}
