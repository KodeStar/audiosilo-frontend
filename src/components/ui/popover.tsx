import * as PopoverPrimitive from '@rn-primitives/popover';
import { Platform, StyleSheet } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';

import {
  FullWindowOverlay,
  NativeOnlyAnimatedView,
  useOverlayInsets,
  withFlatStyle,
} from './overlay';

/**
 * A Stacks popover (STYLEGUIDE.md section 8): react-native-reusables' Popover on a
 * `popover` surface, radius 14, the overlay shadow. Kept inside the safe area on native
 * (`useOverlayInsets`); portaled, so it escapes a clipped card.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

/** Through `withFlatStyle` (see ./overlay). */
const Content = withFlatStyle(PopoverPrimitive.Content);

export function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & { className?: string }) {
  const insets = useOverlayInsets();
  return (
    <PopoverPrimitive.Portal>
      <FullWindowOverlay>
        <PopoverPrimitive.Overlay
          style={Platform.select({ native: StyleSheet.absoluteFill })}
          asChild={Platform.OS !== 'web'}
        >
          <NativeOnlyAnimatedView
            entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.reduceMotion(ReduceMotion.System)}
            as="Pressable"
          >
            <Content
              align={align}
              sideOffset={sideOffset}
              insets={insets}
              className={cn(
                'z-50 w-72 rounded-menu border border-border bg-popover p-4 shadow-overlay',
                Platform.select({
                  web: cn(
                    'cursor-auto outline-none animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
                    'origin-(--radix-popover-content-transform-origin)',
                  ),
                }),
                className,
              )}
              {...props}
            />
          </NativeOnlyAnimatedView>
        </PopoverPrimitive.Overlay>
      </FullWindowOverlay>
    </PopoverPrimitive.Portal>
  );
}
