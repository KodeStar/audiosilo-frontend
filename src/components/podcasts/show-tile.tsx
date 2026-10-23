import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { PodcastShow } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { TileCaption } from '@/components/library/cover-tile';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';

import { isRecent } from './podcast-model';

/**
 * A show as a cover tile (Bridge Phase 2d-1): its artwork (the show folder's cover), its
 * title and one caption line, and a "Private feed" mark on a private one. One button,
 * opening the show page. Not a `CoverTile`: a show has no progress, download or book
 * actions.
 */
export function ShowTile({
  connectionId,
  show,
  width,
  onPress,
}: {
  connectionId: string;
  show: PodcastShow;
  width: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  // "New episode 2 days ago" while its latest is recent, else the show's author.
  const caption = isRecent(show.latest_published, new Date())
    ? t('podcasts.shows.newEpisode', { when: formatRelative(show.latest_published ?? '') })
    : show.author;
  const label = [show.title, caption, show.private ? t('podcasts.shows.privateBadge') : '']
    .filter(Boolean)
    .join(', ');
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ width }}
      className="gap-2.5 rounded-cover"
      testID="show-tile"
    >
      <View>
        <BookCover
          connectionId={connectionId}
          libraryId={show.library_id}
          path={show.path}
          coverVersion={show.cover_version}
          width={width}
          title={show.title}
          author={show.author}
        />
        {show.private ? (
          <View pointerEvents="none" className="absolute left-2 top-2">
            <Badge variant="ink">
              <Text>{t('podcasts.shows.privateBadge')}</Text>
            </Badge>
          </View>
        ) : null}
      </View>
      <TileCaption title={show.title} caption={caption} />
    </AnimatedPressable>
  );
}
