import { View } from 'react-native';

import { EmptyState, type EmptyStateProps } from '@/components/ui/empty-state';

import { Plank } from './bookcase';
import { Spine } from './spine';

const GHOSTS = [
  { width: 30, height: 150 },
  { width: 40, height: 168 },
  { width: 26, height: 140 },
];

/** A few dashed ghost spines on a plank (decorative). */
function GhostShelf() {
  return (
    <View className="w-[180px]">
      <View
        className="flex-row items-end justify-center"
        style={{ gap: 4 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {GHOSTS.map((g, i) => (
          <Spine key={i} title="" variant="ghost" scale={0.8} {...g} />
        ))}
      </View>
      <Plank className="mx-0" />
    </View>
  );
}

/**
 * An empty (or failed) series or people page: the `EmptyState` over a ghost shelf (a
 * few dashed spines on a plank).
 */
export function EmptyShelf(props: Pick<EmptyStateProps, 'title' | 'hint' | 'action'>) {
  return <EmptyState art={<GhostShelf />} {...props} />;
}
