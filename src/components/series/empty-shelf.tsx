import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

import { Plank } from './bookcase';
import { Spine } from './spine';

const GHOSTS = [
  { width: 30, height: 150 },
  { width: 40, height: 168 },
  { width: 26, height: 140 },
];

/**
 * An empty (or failed) series or people page (STYLEGUIDE section 8, "Empty"): a few
 * dashed ghost spines on a plank, one headline, one sentence, at most one action.
 */
export function EmptyShelf({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
}) {
  return (
    <View className="items-center gap-3 px-6 py-12">
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
      <Text variant="title" className="text-center" accessibilityRole="header">
        {title}
      </Text>
      {hint ? (
        <Text variant="muted" className="max-w-[420px] text-center">
          {hint}
        </Text>
      ) : null}
      {action ? (
        <Button
          title={action.label}
          icon={action.icon}
          variant="secondary"
          onPress={action.onPress}
          className="mt-1"
        />
      ) : null}
    </View>
  );
}
