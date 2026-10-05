import * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import { Platform, StyleSheet } from 'react-native';
import { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';
import {
  FullWindowOverlay,
  NativeOnlyAnimatedView,
  useOverlayInsets,
  withFlatStyle,
} from './overlay';
import { EYEBROW_CLASS, TextClassContext } from './text';

/**
 * A Stacks menu (STYLEGUIDE.md section 8): react-native-reusables' DropdownMenu on a
 * `popover` surface, radius 14, with 36px (web) / 44pt (touch) items, an optional
 * leading glyph and a `destructive` item variant. Portaled and safe-area aware.
 */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

/** Through `withFlatStyle` (see ./overlay). */
const Content = withFlatStyle(DropdownMenuPrimitive.Content);

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & { className?: string }) {
  const insets = useOverlayInsets();
  return (
    <DropdownMenuPrimitive.Portal>
      <FullWindowOverlay>
        <DropdownMenuPrimitive.Overlay
          style={Platform.select({ native: StyleSheet.absoluteFill })}
          asChild={Platform.OS !== 'web'}
        >
          <NativeOnlyAnimatedView
            entering={FadeIn.reduceMotion(ReduceMotion.System)}
            as="Pressable"
          >
            <Content
              sideOffset={sideOffset}
              insets={insets}
              className={cn(
                'z-50 min-w-[230px] overflow-hidden rounded-menu border border-border bg-popover p-1.5 shadow-overlay',
                Platform.select({
                  web: cn(
                    'cursor-default animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
                    'origin-(--radix-dropdown-menu-content-transform-origin)',
                  ),
                }),
                className,
              )}
              {...props}
            />
          </NativeOnlyAnimatedView>
        </DropdownMenuPrimitive.Overlay>
      </FullWindowOverlay>
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  className?: string;
  /** A leading glyph (muted, or red on a destructive item). */
  icon?: IconName;
  variant?: 'default' | 'destructive';
}) {
  const themed = useThemeColors();
  const destructive = variant === 'destructive';
  return (
    <TextClassContext.Provider
      value={cn('font-sans text-sm', destructive ? 'text-destructive' : 'text-popover-foreground')}
    >
      <DropdownMenuPrimitive.Item
        className={cn(
          'min-h-[44px] flex-row items-center gap-2.5 rounded-[9px] px-2.5 active:bg-accent',
          Platform.select({
            web: 'min-h-[36px] cursor-pointer outline-none hover:bg-accent focus:bg-accent data-[disabled]:pointer-events-none',
          }),
          destructive && 'active:bg-destructive-soft',
          props.disabled && 'opacity-50',
          className,
        )}
        {...props}
      >
        {icon ? (
          <Icon
            name={icon}
            size={16}
            color={destructive ? themed.destructive : themed.mutedForeground}
          />
        ) : null}
        <>{children}</>
      </DropdownMenuPrimitive.Item>
    </TextClassContext.Provider>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { className?: string }) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(EYEBROW_CLASS, 'px-2.5 pb-1 pt-1.5 text-subtle-foreground', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator> & { className?: string }) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('mx-1 my-1.5 h-px bg-border', className)}
      {...props}
    />
  );
}
