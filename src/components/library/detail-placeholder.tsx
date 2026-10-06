import { ScrollView } from 'react-native';

import { useMiniPlayerInset } from '@/components/player/mini-player';
import { EmptyState } from '@/components/ui/empty-state';
import { Text } from '@/components/ui/text';

/**
 * The shared body of the Phase 2 detail pages until their screens land: the page's
 * heading and a quiet note. Each detail screen (series, author/narrator, collection)
 * replaces its use of this with the real page.
 */
export function DetailPlaceholder({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title?: string;
  hint: string;
}) {
  const paddingBottom = useMiniPlayerInset();
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-2 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <Text variant="eyebrow">{eyebrow}</Text>
      {title ? (
        <Text variant="display" accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <EmptyState icon="library" title={hint} />
    </ScrollView>
  );
}
