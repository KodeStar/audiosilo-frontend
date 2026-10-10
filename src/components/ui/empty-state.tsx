import type { ReactNode } from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Button } from './button';
import { Icon, type IconName } from './icon';
import { Text } from './text';

export type EmptyStateProps = {
  /** Any glyph from icon-data.ts; defaults to the neutral "inbox". Not drawn with `art`. */
  icon?: IconName;
  /** The state's picture (`GhostCovers`, `GhostSpines`, a ghost shelf) in place of the
   * icon. */
  art?: ReactNode;
  title: string;
  /** One-line supporting hint below the title. */
  hint?: string;
  /** Optional call to action. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  /** `card`: on a quiet card, for a state inside a page (a list's empty or failed load). */
  variant?: 'plain' | 'card';
  /** `large`: kids mode's bigger words and its big ink button (STYLEGUIDE section 5: 64 pt
   * the kids-mode minimum). */
  size?: 'default' | 'large';
  className?: string;
};

/**
 * An empty state (STYLEGUIDE section 8: one picture, one headline, one sentence, one
 * action), centred. Plain by default - it teaches rather than boxing off a gray
 * sentence - or on a quiet card (`variant="card"`). A picture (`art`) makes it a page's
 * state, with a heading; an icon keeps it a quiet section note.
 */
export function EmptyState({
  icon = 'inbox',
  art,
  title,
  hint,
  action,
  variant = 'plain',
  size = 'default',
  className,
}: EmptyStateProps) {
  const themed = useThemeColors();
  const card = variant === 'card';
  const large = size === 'large';
  return (
    // cn: a caller's padding (e.g. a tab panel's py-6) must beat the default on every
    // platform, not only where the stylesheet happens to order it last.
    <View
      className={cn(
        'items-center justify-center gap-3 px-6',
        card ? 'rounded-2xl border border-border bg-card py-10' : 'py-12',
        className,
      )}
    >
      {art ?? <Icon name={icon} size={40} color={themed.mutedForeground} />}
      <Text
        variant={art || card ? 'heading' : 'title'}
        className={cn('text-center', large && 'font-display text-2xl')}
        accessibilityRole="header"
      >
        {title}
      </Text>
      {hint ? (
        <Text variant="muted" className={cn('max-w-[440px] text-center', large && 'text-base')}>
          {hint}
        </Text>
      ) : null}
      {action ? (
        <Button
          title={action.label}
          icon={action.icon}
          variant={large ? 'default' : card ? 'outline' : 'secondary'}
          size={large ? 'xl' : card ? 'sm' : undefined}
          onPress={action.onPress}
          className={card && !large ? undefined : 'mt-2'}
        />
      ) : null}
    </View>
  );
}
