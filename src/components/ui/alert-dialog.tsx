import * as AlertDialogPrimitive from '@rn-primitives/alert-dialog';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';

import { dialogDescriptionClass, dialogTitleClass, useDialogFrame } from './dialog';
import { FullWindowOverlay, NativeOnlyAnimatedView } from './overlay';

/**
 * A confirmation that needs an answer (STYLEGUIDE.md section 8): react-native-reusables'
 * AlertDialog, framed like Dialog (`useDialogFrame`) but without a close button or a
 * backdrop dismiss - only its own actions, Escape (web) and Android back close it.
 *
 * Use plain `Button`s for the actions and own `open` in the caller: rn-primitives'
 * Action/Cancel parts would also fire `onOpenChange(false)` on every press.
 */
export const AlertDialog = AlertDialogPrimitive.Root;

function AlertDialogOverlay({ className, children }: { className: string; children: ReactNode }) {
  return (
    <FullWindowOverlay>
      <AlertDialogPrimitive.Overlay className={className} asChild={Platform.OS !== 'web'}>
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(200).delay(50).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          <>{children}</>
        </NativeOnlyAnimatedView>
      </AlertDialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}

export function AlertDialogContent({
  className,
  style,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & { className?: string }) {
  const frame = useDialogFrame();
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogOverlay className={frame.overlayClassName}>
        <AlertDialogPrimitive.Content
          className={cn(frame.contentClassName, className)}
          // One flat object: on web Radix's Slot merges `style` by object spread, and an
          // array turned into {0: ...} crashes react-native-web's style setter.
          style={StyleSheet.flatten([frame.contentStyle, style])}
          {...props}
        />
      </AlertDialogOverlay>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('gap-2', className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn('flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title> & { className?: string }) {
  return <AlertDialogPrimitive.Title className={cn(dialogTitleClass, className)} {...props} />;
}

export function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description> & { className?: string }) {
  return (
    <AlertDialogPrimitive.Description
      className={cn(dialogDescriptionClass, className)}
      {...props}
    />
  );
}
