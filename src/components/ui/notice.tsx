import { View } from 'react-native';

import { useThemeColors } from '@/theme/use-theme-colors';

import { Card } from './card';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type NoticeTone = 'info' | 'success' | 'warning';

/** The icon tile's tint per tone (literal classes, so the stylesheet compiler sees them). */
const TILE: Record<NoticeTone, string> = {
  info: 'bg-info-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
};

/** A notice (STYLEGUIDE section 8, "Notice"): a tinted icon tile, a bold headline and one
 * sentence, explaining a local situation (how this device plays a book, why a book is in
 * parts, what this browser can keep offline). Status is the icon and the words, never the
 * tint alone. */
export function Notice({
  icon,
  tone = 'info',
  title,
  body,
  testID,
}: {
  icon: IconName;
  tone?: NoticeTone;
  title: string;
  body: string;
  testID?: string;
}) {
  const themed = useThemeColors();
  return (
    <Card testID={testID} className="flex-row items-start gap-3.5 p-4">
      <View className={`h-9 w-9 items-center justify-center rounded-[11px] ${TILE[tone]}`}>
        <Icon name={icon} size={17} color={themed[tone]} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label">{title}</Text>
        <Text variant="muted">{body}</Text>
      </View>
    </Card>
  );
}
