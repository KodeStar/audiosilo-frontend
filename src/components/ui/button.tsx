import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { Platform, Pressable, type PressableProps } from 'react-native';

import { cn } from '@/lib/utils';
import { colors, type ThemeColors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';
import { Spinner } from './spinner';
import { Text, TextClassContext } from './text';

/**
 * The Stacks button (STYLEGUIDE.md section 8): react-native-reusables' Button, restyled.
 * `default` is INK (primary actions); `brand` (pink) is for at most one moment in a
 * flow. Sizes are 30 / 38 / 46 / 54 tall.
 */
const buttonVariants = cva(
  cn(
    'shrink-0 flex-row items-center justify-center gap-2 rounded-control border border-transparent',
    Platform.select({
      web: 'cursor-pointer select-none whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    }),
  ),
  {
    variants: {
      variant: {
        default: 'bg-primary active:opacity-90 hover:opacity-90',
        brand: 'bg-brand active:opacity-90 hover:opacity-90',
        outline: 'border-border-strong bg-card active:bg-accent hover:bg-accent',
        secondary: 'bg-secondary active:bg-accent hover:bg-accent',
        ghost: 'active:bg-accent hover:bg-accent',
        destructive: 'bg-destructive active:opacity-90 hover:opacity-90',
        'destructive-outline':
          'border-destructive/40 active:bg-destructive-soft hover:bg-destructive-soft',
        link: 'h-auto px-0',
      },
      size: {
        sm: 'h-[30px] gap-1.5 rounded-lg px-2.5',
        default: 'h-[38px] px-4',
        lg: 'h-[46px] rounded-xl px-5',
        xl: 'h-[54px] rounded-menu px-6',
        icon: 'h-[38px] w-[38px] px-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/** The label classes each variant hands its `<Text>` (via TextClassContext). */
const buttonTextVariants = cva('font-sans-semibold text-sm', {
  variants: {
    variant: {
      default: 'text-primary-foreground',
      brand: 'text-brand-foreground',
      outline: 'text-foreground',
      secondary: 'text-secondary-foreground',
      ghost: 'text-foreground',
      destructive: 'text-white',
      'destructive-outline': 'text-destructive',
      link: 'text-brand-ink',
    },
    size: { sm: 'text-xs', default: '', lg: 'text-base', xl: 'text-base', icon: '' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

type Variant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
type Size = NonNullable<VariantProps<typeof buttonVariants>['size']>;

/** The SVG fill for an icon on each variant (SVG takes a colour, not a class). */
function iconColor(variant: Variant, themed: ThemeColors): string {
  switch (variant) {
    case 'default':
      return themed.primaryForeground;
    case 'brand':
      return themed.brandForeground;
    case 'secondary':
      return themed.secondaryForeground;
    case 'destructive':
      return colors.white;
    case 'destructive-outline':
      return themed.destructive;
    case 'link':
      return themed.brandInk;
    default:
      return themed.foreground;
  }
}

/** Grows the touch area of the short sizes to the 44pt minimum (STYLEGUIDE section 14). */
const HIT_SLOP: Record<Size, number> = { sm: 7, default: 3, lg: 0, xl: 0, icon: 3 };

export type ButtonProps = Omit<PressableProps, 'children'> & {
  variant?: Variant;
  size?: Size;
  /** The label. Or compose `children` (`<Icon/><Text/>`), which inherit the label style. */
  title?: string;
  /** A leading glyph, tinted to the variant. Icon-only buttons need an accessibilityLabel. */
  icon?: IconName;
  /** Swaps the icon for a spinner and disables the button. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * A button. Pass `title` (+ `icon`) for the common case, or compose `children`:
 * a `<Text>` inside picks up the variant's label style from `TextClassContext`.
 */
export function Button({
  variant = 'default',
  size = 'default',
  title,
  icon,
  loading = false,
  disabled,
  className,
  children,
  hitSlop,
  ...props
}: ButtonProps) {
  const themed = useThemeColors();
  const isDisabled = !!disabled || loading;
  const tint = iconColor(variant, themed);
  const glyph = size === 'lg' || size === 'xl' ? 18 : 16;
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        role="button"
        disabled={isDisabled}
        aria-disabled={isDisabled}
        aria-busy={loading || undefined}
        hitSlop={hitSlop ?? HIT_SLOP[size]}
        className={cn(buttonVariants({ variant, size }), isDisabled && 'opacity-45', className)}
        {...props}
      >
        {loading ? (
          <Spinner color={tint} />
        ) : icon ? (
          <Icon name={icon} size={glyph} color={tint} />
        ) : null}
        {title ? <Text>{title}</Text> : null}
        {children}
      </Pressable>
    </TextClassContext.Provider>
  );
}
