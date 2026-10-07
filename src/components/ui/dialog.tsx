import * as DialogPrimitive from '@rn-primitives/dialog';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type GestureResponderEvent,
  Platform,
  type StyleProp,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { useKeyboardAvoidance } from '@/lib/keyboard-lift';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon, type IconName } from './icon';
import { FullWindowOverlay, NativeOnlyAnimatedView, useRootInsets, withFlatStyle } from './overlay';

/**
 * Stacks dialogs (STYLEGUIDE.md section 8): react-native-reusables' Dialog, restyled.
 * Radius 20 and a sensible width (at most 520) on tablet and desktop; on a phone
 * (`useLayout()`) the dialog rises from the bottom edge like a sheet (radius 24 top corners, clear of the
 * home indicator). Portaled (see ./overlay), so it can be opened from anywhere - inside a
 * card, a list row, a ScrollView.
 *
 * Shared with AlertDialog: `DialogFrame` (over `useDialogFrame`), the header/footer and
 * the title/description classes below.
 */

/** The frame classes and the phone sheet's bottom padding. Reads the ROOT safe-area
 * insets (`useRootInsets`), so it gives the same frame wherever it is called. */
export function useDialogFrame() {
  const insets = useRootInsets();
  // A phone presents a dialog as a bottom sheet.
  const compact = useLayout() === 'phone';
  // A keyboard lying over the window (iOS, edge-to-edge Android): the phone sheet rises
  // above it (a field in it, like a collection's name, stays in view) and fits under the
  // top safe edge. Nothing listened to on a tablet or desktop.
  const keyboard = useKeyboardAvoidance({
    active: compact,
    fraction: 1,
    bottomInset: insets.bottom,
    topInset: insets.top,
  });
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
    contentStyle: compact
      ? {
          paddingBottom: Math.max(24, insets.bottom + 16),
          ...(keyboard.lift > 0 ? { marginBottom: keyboard.lift, maxHeight: keyboard.cap } : {}),
        }
      : undefined,
  };
}

type FrameContentProps = { className?: string; style?: StyleProp<ViewStyle> };

/**
 * The overlay + card every dialog kind shares: `Overlay` (the kind's scrim and its
 * dismiss rules) around `Content` (the kind's Content part, through `withFlatStyle`),
 * framed by `useDialogFrame`. The caller's `className` and `style` merge after the
 * frame's.
 */
export function DialogFrame<P extends FrameContentProps>({
  Overlay,
  Content,
  contentProps,
}: {
  Overlay: ComponentType<{ className: string; children: ReactNode }>;
  Content: ComponentType<P>;
  contentProps: P;
}) {
  const frame = useDialogFrame();
  return (
    <Overlay className={frame.overlayClassName}>
      <Content
        {...contentProps}
        className={cn(frame.contentClassName, contentProps.className)}
        style={[frame.contentStyle, contentProps.style]}
      />
    </Overlay>
  );
}

/** Header and footer classes (shared with AlertDialog). */
export const dialogHeaderClass = 'gap-2';
export const dialogFooterClass = 'flex-col-reverse gap-2 sm:flex-row sm:justify-end';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

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

const Content = withFlatStyle(DialogPrimitive.Content);

export function DialogContent({ children, showClose = true, ...props }: DialogContentProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <DialogPrimitive.Portal>
      <DialogFrame
        Overlay={DialogOverlay}
        Content={Content}
        contentProps={{
          ...props,
          children: (
            <>
              {children}
              {showClose ? (
                <DialogPrimitive.Close
                  accessibilityLabel={t('common.close')}
                  hitSlop={4}
                  className={cn(
                    'absolute right-3 top-3 h-10 w-10 items-center justify-center rounded-full active:bg-accent',
                    Platform.select({
                      web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}`,
                    }),
                  )}
                >
                  <Icon name="close" size={18} color={themed.mutedForeground} />
                </DialogPrimitive.Close>
              ) : null}
            </>
          ),
        }}
      />
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ViewProps & { className?: string }) {
  // Clear of the close button.
  return <View className={cn(dialogHeaderClass, 'pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn(dialogFooterClass, className)} {...props} />;
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
