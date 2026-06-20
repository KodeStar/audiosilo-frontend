import { ActivityIndicator, Pressable, Text as RNText, type PressableProps } from 'react-native';

import { colors } from '@/theme/tokens';

import { Icon, type IconName } from './icon';

type Variant = 'primary' | 'secondary' | 'ghost';

const containerBase =
  'flex-row items-center justify-center gap-2 rounded-lg px-4 py-3 active:opacity-80';

const containerVariant: Record<Variant, string> = {
  primary: 'bg-primary',
  secondary: 'bg-gray-100 border border-gray-200 dark:border-gray-750 dark:bg-gray-840',
  ghost: 'bg-transparent',
};

const labelVariant: Record<Variant, string> = {
  primary: 'text-white',
  secondary: 'text-gray-700 dark:text-gray-200',
  ghost: 'text-primary',
};

const iconColor: Record<Variant, string> = {
  primary: colors.white,
  secondary: colors.dark.text,
  ghost: colors.primary,
};

export type ButtonProps = Omit<PressableProps, 'children'> & {
  title: string;
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
  const isDisabled = disabled || loading;
  return (
    <Pressable
      disabled={isDisabled}
      accessibilityRole="button"
      className={`${containerBase} ${containerVariant[variant]} ${isDisabled ? 'opacity-50' : ''} ${className ?? ''}`}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.white : colors.primary} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={16} color={iconColor[variant]} /> : null}
          <RNText className={`font-roboto-semibold text-base ${labelVariant[variant]}`}>
            {title}
          </RNText>
        </>
      )}
    </Pressable>
  );
}
