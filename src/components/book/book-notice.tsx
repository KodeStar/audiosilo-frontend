import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

type Tone = 'info' | 'success' | 'warning';

const TILE: Record<Tone, string> = {
  info: 'bg-info-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
};

/** A notice (STYLEGUIDE section 8, "Notice"): a tinted icon tile, a bold headline and one
 * sentence, explaining a local situation (how this device plays the book, why a book is
 * in parts). Status is the icon and the words, never the tint alone. */
export function BookNotice({
  icon,
  tone,
  title,
  body,
  testID,
}: {
  icon: IconName;
  tone: Tone;
  title: string;
  body: string;
  testID?: string;
}) {
  const themed = useThemeColors();
  const color =
    tone === 'info' ? themed.info : tone === 'success' ? themed.success : themed.warning;
  return (
    <Card testID={testID} className="flex-row items-start gap-3.5 p-4">
      <View className={`h-9 w-9 items-center justify-center rounded-[11px] ${TILE[tone]}`}>
        <Icon name={icon} size={17} color={color} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label">{title}</Text>
        <Text variant="muted">{body}</Text>
      </View>
    </Card>
  );
}
