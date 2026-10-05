import * as TooltipPrimitive from '@rn-primitives/tooltip';
import { Platform, StyleSheet } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';

import { FullWindowOverlay, NativeOnlyAnimatedView, useOverlayInsets } from './overlay';
import { TextClassContext } from './text';

/**
 * A Stacks tooltip (STYLEGUIDE.md section 16: tooltips are ink): react-native-reusables'
 * Tooltip. Meant for web, where it opens on hover and keyboard focus; a tooltip only ever
 * repeats a label the control already exposes to screen readers (its accessibilityLabel),
 * since touch has no hover.
 */
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  side = 'top',
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { className?: string }) {
  const insets = useOverlayInsets();
  return (
    <TooltipPrimitive.Portal>
      <FullWindowOverlay>
        <TooltipPrimitive.Overlay
          style={Platform.select({ native: StyleSheet.absoluteFill })}
          asChild={Platform.OS !== 'web'}
        >
          <NativeOnlyAnimatedView
            entering={FadeIn.duration(150).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.reduceMotion(ReduceMotion.System)}
            as="Pressable"
          >
            <TextClassContext.Provider value="font-sans-semibold text-xs text-primary-foreground">
              <TooltipPrimitive.Content
                sideOffset={sideOffset}
                side={side}
                insets={insets}
                className={cn(
                  'z-50 rounded-lg bg-primary px-2.5 py-1.5 shadow-overlay',
                  Platform.select({
                    web: 'w-fit animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none',
                  }),
                  className,
                )}
                {...props}
              />
            </TextClassContext.Provider>
          </NativeOnlyAnimatedView>
        </TooltipPrimitive.Overlay>
      </FullWindowOverlay>
    </TooltipPrimitive.Portal>
  );
}
