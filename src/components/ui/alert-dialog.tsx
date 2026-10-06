import * as AlertDialogPrimitive from '@rn-primitives/alert-dialog';
import type { ReactNode } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { cn } from '@/lib/utils';

import {
  dialogDescriptionClass,
  dialogFooterClass,
  DialogFrame,
  dialogHeaderClass,
  dialogTitleClass,
} from './dialog';
import { FullWindowOverlay, NativeOnlyAnimatedView, withFlatStyle } from './overlay';

/**
 * A confirmation that needs an answer (STYLEGUIDE.md section 8): react-native-reusables'
 * AlertDialog, framed like Dialog (`DialogFrame`) but without a close button or a
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

type AlertDialogContentProps = React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  className?: string;
};

const Content = withFlatStyle(AlertDialogPrimitive.Content);

export function AlertDialogContent(props: AlertDialogContentProps) {
  return (
    <AlertDialogPrimitive.Portal>
      <DialogFrame Overlay={AlertDialogOverlay} Content={Content} contentProps={props} />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn(dialogHeaderClass, className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn(dialogFooterClass, className)} {...props} />;
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
