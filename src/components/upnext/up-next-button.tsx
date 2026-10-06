import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatCount } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { toggleUpNext, useUpNext } from './up-next-store';
import { useUpNextBadge } from './use-up-next';

/** The badge's text: the count, capped so it stays a badge. */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : formatCount(count);
}

/**
 * The Up next entry point (the `queue` glyph with the count): the top bar on tablet and
 * desktop (`variant="bar"`, 38 square), the phone header on tab roots (`variant="header"`,
 * 44), and the docked player (`variant="dock"`, no count). It toggles the drawer on a
 * desktop (and shows it pressed while open) or opens the sheet elsewhere. Renders
 * nothing unless the server is known to have `queue`.
 */
export function UpNextButton({ variant }: { variant: 'bar' | 'header' | 'dock' }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const desktop = useLayout() === 'desktop';
  const drawerOpen = useUpNext((s) => s.drawerOpen);
  const { supported, count } = useUpNextBadge();
  if (supported !== true) return null;
  const pressed = desktop && drawerOpen;
  const label = count > 0 ? t('upnext.buttonLabel', { count }) : t('upnext.buttonLabelEmpty');
  const showCount = variant !== 'dock' && count > 0;
  return (
    <AnimatedPressable
      testID={`upnext-button-${variant}`}
      onPress={toggleUpNext}
      accessibilityRole="button"
      accessibilityLabel={label}
      // Web: the drawer's state as a toggle (aria-pressed); a sheet is a plain button.
      aria-pressed={desktop ? pressed : undefined}
      className={cn(
        'items-center justify-center border',
        variant === 'header' ? 'h-11 w-11 rounded-full' : 'h-[38px] w-[38px] rounded-control',
        pressed
          ? variant === 'dock'
            ? 'border-transparent bg-brand-soft'
            : 'border-border bg-card'
          : 'border-transparent active:bg-accent',
        Platform.select({
          web: cn(
            !pressed && 'hover:bg-accent',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring',
          ),
        }),
      )}
    >
      <Icon
        name="queue"
        size={variant === 'header' ? 20 : 19}
        color={pressed ? themed.foreground : themed.mutedForeground}
      />
      {showCount ? (
        <View
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          className={cn(
            'absolute h-[17px] min-w-[17px] items-center justify-center rounded-full border-2 border-background bg-primary px-1',
            variant === 'header' ? 'right-0.5 top-1' : 'right-0 top-0.5',
          )}
        >
          <Text
            style={tabularNums}
            className="font-sans-bold text-[10px] leading-[12px] text-primary-foreground"
          >
            {badgeText(count)}
          </Text>
        </View>
      ) : null}
    </AnimatedPressable>
  );
}
