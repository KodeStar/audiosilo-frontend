import * as SelectPrimitive from '@rn-primitives/select';
import { Platform, StyleSheet, View } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon } from './icon';
import {
  FullWindowOverlay,
  NativeOnlyAnimatedView,
  useOverlayInsets,
  withFlatStyle,
} from './overlay';

/**
 * A Stacks select (STYLEGUIDE.md section 8): react-native-reusables' Select, restyled -
 * an input-shaped trigger (40 tall, radius 10) opening a popover menu (radius 14) whose
 * chosen item carries a check. Portaled, so it can sit inside a card or a ScrollView.
 *
 * The value is rn-primitives' `Option` (`{ value, label }`): pass the selected option
 * and read `option.value` back in `onValueChange`.
 */
export type SelectOption = NonNullable<SelectPrimitive.Option>;

export const Select = SelectPrimitive.Root;

export function SelectValue({
  className,
  placeholder,
}: {
  className?: string;
  placeholder: string;
}) {
  const { value } = SelectPrimitive.useRootContext();
  return (
    <SelectPrimitive.Value
      // Web: rn-primitives' Slot hands these props straight to Radix's <span>, so only
      // DOM-safe ones (className, which Uniwind's web CSS styles) go through - no testID.
      className={cn(
        'line-clamp-1 font-sans text-sm',
        value ? 'text-foreground' : 'text-subtle-foreground',
        className,
      )}
      placeholder={placeholder}
    />
  );
}

export function SelectTrigger({
  className,
  children,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { className?: string }) {
  const themed = useThemeColors();
  const { open, onOpenChange } = SelectPrimitive.useRootContext();
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'h-[40px] flex-row items-center justify-between gap-2 rounded-control border border-input bg-card px-3',
        Platform.select({
          web: 'cursor-pointer outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
        }),
        props.disabled && 'opacity-50',
        className,
      )}
      // Web: Space must open the select like Enter does. react-native-web's press
      // responder preventDefaults Space on a role="button" element before Radix's own
      // key handler runs, and Radix skips default-prevented events - so it never
      // opened (0a spike). This handler runs after the responder; open it ourselves.
      onKeyDown={(e) => {
        onKeyDown?.(e);
        const key = (e as unknown as { key?: string }).key;
        if (Platform.OS === 'web' && !open && (key === ' ' || key === 'Spacebar')) {
          onOpenChange(true);
        }
      }}
      {...props}
    >
      <>{children}</>
      <Icon name="chevron-down" size={14} color={themed.mutedForeground} />
    </SelectPrimitive.Trigger>
  );
}

/** Through `withFlatStyle` (see ./overlay). */
const Content = withFlatStyle(SelectPrimitive.Content);

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content> & { className?: string }) {
  const insets = useOverlayInsets();
  return (
    <SelectPrimitive.Portal>
      <FullWindowOverlay>
        <SelectPrimitive.Overlay
          style={Platform.select({ native: StyleSheet.absoluteFill })}
          asChild={Platform.OS !== 'web'}
        >
          <NativeOnlyAnimatedView
            className="z-50"
            entering={FadeIn.reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.reduceMotion(ReduceMotion.System)}
            as="Pressable"
          >
            <Content
              insets={insets}
              className={cn(
                'relative z-50 min-w-[10rem] rounded-menu border border-border bg-popover p-1.5 shadow-overlay',
                Platform.select({
                  web: cn(
                    'max-h-[min(22rem,var(--radix-select-content-available-height))] overflow-y-auto overflow-x-hidden animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
                    'origin-(--radix-select-content-transform-origin)',
                    props.side === 'top' ? 'slide-in-from-bottom-2' : 'slide-in-from-top-2',
                  ),
                }),
                className,
              )}
              position={position}
              sideOffset={6}
              {...props}
            >
              <SelectPrimitive.Viewport
                className={cn(
                  position === 'popper' &&
                    Platform.select({
                      web: 'w-full min-w-[var(--radix-select-trigger-width)]',
                    }),
                )}
              >
                {children}
              </SelectPrimitive.Viewport>
            </Content>
          </NativeOnlyAnimatedView>
        </SelectPrimitive.Overlay>
      </FullWindowOverlay>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, 'children'> & { className?: string }) {
  const themed = useThemeColors();
  return (
    <SelectPrimitive.Item
      className={cn(
        'min-h-[44px] w-full flex-row items-center gap-2 rounded-[9px] py-2 pl-2.5 pr-9 active:bg-accent',
        Platform.select({
          web: 'min-h-[36px] cursor-pointer outline-none focus:bg-accent hover:bg-accent data-[disabled]:pointer-events-none',
        }),
        props.disabled && 'opacity-50',
        className,
      )}
      {...props}
    >
      <View className="absolute right-2.5 h-4 w-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon name="check" size={14} color={themed.brandInk} />
        </SelectPrimitive.ItemIndicator>
      </View>
      <SelectPrimitive.ItemText className="select-none font-sans text-sm text-popover-foreground" />
    </SelectPrimitive.Item>
  );
}
