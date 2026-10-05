import { ActivityIndicator, Pressable, Text as RNText, type PressableProps } from 'react-native';

import { cn } from '@/lib/utils';
import type { ThemeColors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';

type Variant = 'primary' | 'secondary' | 'ghost';

const containerBase =
  'flex-row items-center justify-center gap-2 rounded-lg px-4 py-3 active:opacity-80';

const containerVariant: Record<Variant, string> = {
  primary: 'bg-brand',
  secondary: 'border border-border bg-secondary',
  ghost: 'bg-transparent',
};

const labelVariant: Record<Variant, string> = {
  primary: 'text-brand-foreground',
  secondary: 'text-secondary-foreground',
  ghost: 'text-brand-ink',
};

const iconColor = (variant: Variant, themed: ThemeColors) =>
  variant === 'primary'
    ? themed.brandForeground
    : variant === 'ghost'
      ? themed.brand
      : themed.secondaryForeground;

export type ButtonProps = Omit<PressableProps, 'children'> & {
  /** Omit for an icon-only button (pass an `accessibilityLabel` instead). */
  title?: string;
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  className?: string;
};

export function Button({
  title,
  variant = 'primary',
  icon,
  loading = false,
  disabled,
  className,
  ...props
}: ButtonProps) {
  const themed = useThemeColors();
  const isDisabled = disabled || loading;
  return (
    <Pressable
      disabled={isDisabled}
      accessibilityRole="button"
      className={cn(
        containerBase,
        containerVariant[variant],
        isDisabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={iconColor(variant, themed)} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={16} color={iconColor(variant, themed)} /> : null}
          {title ? (
            <RNText className={`font-sans-semibold text-base ${labelVariant[variant]}`}>
              {title}
            </RNText>
          ) : null}
        </>
      )}
    </Pressable>
  );
}
