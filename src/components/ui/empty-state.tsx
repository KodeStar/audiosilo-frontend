import { View } from 'react-native';

import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import { Button } from './button';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type EmptyStateProps = {
  /** Any glyph from icon-data.ts; defaults to the neutral "inbox". */
  icon?: IconName;
  title: string;
  /** One-line supporting hint below the title. */
  hint?: string;
  /** Optional call to action. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  className?: string;
};

/**
 * A quiet, centered empty state: a muted icon, a title, an optional hint, and an
 * optional action button. Deliberately borderless (no Card) with generous vertical
 * padding - it teaches rather than boxing off a gray sentence.
 */
export function EmptyState({ icon = 'inbox', title, hint, action, className }: EmptyStateProps) {
  const { scheme } = useTheme();
  const iconColor = colors[scheme].textMuted;

  return (
    <View className={`items-center justify-center gap-3 px-6 py-12 ${className ?? ''}`}>
      <Icon name={icon} size={40} color={iconColor} />
      <Text variant="title" className="text-center">
        {title}
      </Text>
      {hint ? (
        <Text variant="muted" className="text-center">
          {hint}
        </Text>
      ) : null}
      {action ? (
        <Button
          title={action.label}
          icon={action.icon}
          variant="secondary"
          onPress={action.onPress}
          className="mt-2"
        />
      ) : null}
    </View>
  );
}
