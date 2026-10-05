import * as DialogPrimitive from '@rn-primitives/dialog';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type GestureResponderEvent,
  Platform,
  StyleSheet,
  View,
  type ViewProps,
} from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';
import { FullWindowOverlay, NativeOnlyAnimatedView } from './overlay';

/**
 * Stacks dialogs (STYLEGUIDE.md section 8): react-native-reusables' Dialog, restyled.
 * Radius 20 and a sensible width (at most 520) on tablet and desktop; on a phone
 * (`useLayout()`) the dialog rises from the bottom edge like a sheet (radius 24 top corners, clear of the
 * home indicator). Portaled (see ./overlay), so it can be opened from anywhere - inside a
 * card, a list row, a ScrollView.
 *
 * Shared with AlertDialog: `useDialogFrame` + the two class builders below.
 */

/** The frame classes and the phone sheet's bottom padding. Call it from INSIDE the
 * overlay's portal (the root's safe-area context), never from the screen. */
export function useDialogFrame() {
  const insets = useSafeAreaInsets();
  // A phone presents a dialog as a bottom sheet.
  const compact = useLayout() === 'phone';
  const web = Platform.OS === 'web';
  return {
    compact,
    overlayClassName: cn(
      'absolute bottom-0 left-0 right-0 top-0 z-50 bg-overlay',
      compact ? 'justify-end' : 'items-center justify-center p-4',
      web && 'fixed animate-in fade-in-0 motion-reduce:animate-none',
    ),
    contentClassName: cn(
      'z-50 gap-4 border border-border bg-popover p-6 shadow-overlay',
      compact ? 'w-full rounded-t-sheet border-b-0' : 'w-full max-w-[520px] rounded-dialog',
      // Web: Radix wraps the content in a plain, shrink-to-fit <div role="dialog">, so a
      // percentage width collapsed the card to ~145px (0a spike). A viewport width is
      // definite whatever the wrapper does.
      web &&
        cn(
          'max-h-[calc(100vh-2rem)] overflow-y-auto animate-in fade-in-0 motion-reduce:animate-none',
          compact
            ? 'w-[100vw] slide-in-from-bottom-4'
            : 'w-[min(520px,calc(100vw-2rem))] zoom-in-95',
        ),
    ),
    // Phone: keep the actions clear of the home indicator.
    contentStyle: compact ? { paddingBottom: Math.max(24, insets.bottom + 16) } : undefined,
  };
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** The scrim + dismiss-on-backdrop wrapper every dialog frame sits in (the command
 * palette composes its own frame inside it). */
export function DialogOverlay({ className, children }: { className: string; children: ReactNode }) {
  const { onOpenChange } = DialogPrimitive.useRootContext();
  // Web: a click on the backdrop itself (not on the card) dismisses; native wires the
  // same through the primitive's own overlay press.
  const onOverlayPress = (event: GestureResponderEvent) => {
    if (event.target === event.currentTarget && !event.isDefaultPrevented()) onOpenChange(false);
  };
  return (
    <FullWindowOverlay>
      <DialogPrimitive.Overlay
        className={className}
        onPress={Platform.select({ web: onOverlayPress })}
        asChild={Platform.OS !== 'web'}
      >
        <NativeOnlyAnimatedView
          entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          as="Pressable"
        >
          <NativeOnlyAnimatedView
            entering={FadeIn.delay(50).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(150).reduceMotion(ReduceMotion.System)}
          >
            <>{children}</>
          </NativeOnlyAnimatedView>
        </NativeOnlyAnimatedView>
      </DialogPrimitive.Overlay>
    </FullWindowOverlay>
  );
}

type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  className?: string;
  /** The top-right close button (default on). */
  showClose?: boolean;
};

export function DialogContent(props: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogFrame {...props} />
    </DialogPrimitive.Portal>
  );
}

/**
 * The overlay + card, rendered INSIDE the portal so `useDialogFrame` reads the root's
 * safe-area insets: a tab screen's own context counts the native tab bar in its bottom
 * inset, which padded a phone sheet ~100pt too tall (iOS).
 */
function DialogFrame({
  className,
  children,
  style,
  showClose = true,
  ...props
}: DialogContentProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const frame = useDialogFrame();
  return (
    <>
      <DialogOverlay className={frame.overlayClassName}>
        <DialogPrimitive.Content
          className={cn(frame.contentClassName, className)}
          // One flat object: on web Radix's Slot merges `style` by object spread, and an
          // array turned into {0: ...} crashes react-native-web's style setter.
          style={StyleSheet.flatten([frame.contentStyle, style])}
          {...props}
        >
          <>{children}</>
          {showClose ? (
            <DialogPrimitive.Close
              accessibilityLabel={t('common.close')}
              hitSlop={4}
              className={cn(
                'absolute right-3 top-3 h-10 w-10 items-center justify-center rounded-full active:bg-accent',
                Platform.select({
                  web: 'cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                }),
              )}
            >
              <Icon name="close" size={18} color={themed.mutedForeground} />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </>
  );
}

export function DialogHeader({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn('gap-2 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn('flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

/** Dialog title classes (shared with AlertDialog): the Stacks heading role. */
export const dialogTitleClass = 'font-display text-lg tracking-tight text-foreground';
/** Dialog description classes (shared with AlertDialog): muted body text. */
export const dialogDescriptionClass = 'font-sans text-sm text-muted-foreground';

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & { className?: string }) {
  return <DialogPrimitive.Title className={cn(dialogTitleClass, className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description> & { className?: string }) {
  return (
    <DialogPrimitive.Description className={cn(dialogDescriptionClass, className)} {...props} />
  );
}

const ICON_TONE = {
  default: { box: 'bg-secondary', color: 'secondaryForeground' },
  destructive: { box: 'bg-destructive-soft', color: 'destructive' },
  brand: { box: 'bg-brand-soft', color: 'brandInk' },
} as const;

/** The 40px tinted icon badge that heads a Stacks dialog. Decorative (the title says it). */
export function DialogIcon({
  name,
  tone = 'default',
}: {
  name: IconName;
  tone?: keyof typeof ICON_TONE;
}) {
  const themed = useThemeColors();
  const { box, color } = ICON_TONE[tone];
  return (
    <View
      className={cn('h-10 w-10 items-center justify-center rounded-xl', box)}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Icon name={name} size={18} color={themed[color]} />
    </View>
  );
}
