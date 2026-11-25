import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { useLayout } from '@/lib/layout';
import { screenReaderOn, watchScreenReader } from '@/lib/screen-reader';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon } from './icon';
import { FullWindowOverlay } from './overlay';
import { FOCUS_RING_CLASS, Text } from './text';
import { slopTo44 } from './touch-target';

/**
 * Stacks toasts (STYLEGUIDE.md section 8): ink cards with one line, an optional
 * description and at most one action: full width at the bottom of a phone, bottom-right
 * on tablet and desktop (`useLayout()`). The shell tells the host how far up to sit, clear
 * of its tab bar, mini player or docked player (`ShellToastHost`).
 *
 *   toast({ title: 'Bookmark added', action: { label: 'Add note', onPress: openNote } });
 *
 * `toast()` can be called from anywhere (no hook, no provider): the state lives in a
 * tiny store and `<ToastHost />` (mounted once, in the root layout) renders it. Each
 * toast is announced to screen readers and dismisses itself after `duration`.
 *
 * Timing for a screen reader (fe#267, WCAG 2.2.1): with VoiceOver or TalkBack on, a toast
 * with an action (Undo) stays until it is answered or closed, and one without stays three
 * times as long (`toastDuration`): reaching an action by swiping takes longer than 8 s. The
 * web can't tell a screen reader is on, so there a toast's timer pauses while the pointer
 * is over it or focus is in it, and starts again from where it was.
 */
export type ToastOptions = {
  title: string;
  description?: string;
  /** At most one action ("Undo", "Add note", "Show"); pressing it also dismisses. */
  action?: { label: string; onPress: () => void };
  /** Milliseconds on screen (default 5s, 8s with an action so it can be reached). */
  duration?: number;
  /** Called when the listener closes the toast with its close button (an answer: "Stay"
   * beside a "Jump"), never when it times out or its action is pressed. */
  onClose?: () => void;
  /** Called when the toast dismisses itself after `duration` (nobody answered it), never
   * when it is closed, its action pressed, or it is pushed off the stack. */
  onTimeout?: () => void;
  /** The close button's label for assistive tech (default "Dismiss"). */
  closeLabel?: string;
};

type ToastItem = ToastOptions & { id: number };

/** Older toasts beyond this are dropped: a stack, not a log. */
const MAX_VISIBLE = 3;
/** How much longer a toast without an action stays while a screen reader is on. */
const SCREEN_READER_FACTOR = 3;

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));

let nextId = 1;
/** What holds a toast's auto-dismiss on the web: the pointer over it, focus in it. */
type ToastHold = 'pointer' | 'focus';
/** A toast's auto-dismiss: the running timeout (none while paused), when it started, how
 * much of its time was left then, and what is holding it. */
type Timer = {
  handle?: ReturnType<typeof setTimeout>;
  started: number;
  remaining: number;
  fire: () => void;
  holds: Set<ToastHold>;
};
const timers = new Map<number, Timer>();

watchScreenReader();

/**
 * How long a toast stays, in ms, or null for "until answered": the caller's `duration`,
 * else 5 s (8 s with an action); with a screen reader on, a toast with an action stays and
 * one without stays `SCREEN_READER_FACTOR` times as long.
 */
export function toastDuration(
  options: Pick<ToastOptions, 'duration' | 'action'>,
  screenReader: boolean,
): number | null {
  const base = options.duration ?? (options.action ? 8000 : 5000);
  if (!screenReader) return base;
  return options.action ? null : base * SCREEN_READER_FACTOR;
}

/** Cancels a toast's auto-dismiss timer, if it still has one. */
function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
}

function run(timer: Timer) {
  timer.started = Date.now();
  timer.handle = setTimeout(timer.fire, timer.remaining);
}

/** Holds a toast's auto-dismiss (the web: the pointer is over it or focus is in it). */
export function pauseToast(id: number, hold: ToastHold = 'pointer') {
  const timer = timers.get(id);
  if (!timer) return;
  timer.holds.add(hold);
  if (!timer.handle) return;
  clearTimeout(timer.handle);
  timer.handle = undefined;
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.started));
}

/** Lets go of one hold on a toast; once nothing holds it (the pointer has left AND focus
 * is out), its auto-dismiss runs on for the time it had left. */
export function resumeToast(id: number, hold: ToastHold = 'pointer') {
  const timer = timers.get(id);
  if (!timer) return;
  timer.holds.delete(hold);
  if (timer.handle || timer.holds.size > 0) return;
  run(timer);
}

/** Removes a toast (a no-op when it has already gone). */
export function dismissToast(id: number) {
  clearTimer(id);
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

/** Shows a toast and returns its id (for an early `dismissToast`). */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  const duration = toastDuration(options, screenReaderOn());
  useToasts.setState((s) => {
    const items = [...s.items, { ...options, id }];
    for (const old of items.slice(0, Math.max(0, items.length - MAX_VISIBLE))) clearTimer(old.id);
    return { items: items.slice(-MAX_VISIBLE) };
  });
  if (duration !== null) {
    const timer: Timer = {
      started: 0,
      remaining: duration,
      fire: () => {
        dismissToast(id);
        options.onTimeout?.();
      },
      holds: new Set(),
    };
    timers.set(id, timer);
    run(timer);
  }
  return id;
}

/**
 * Renders the live toasts. Mount ONE, last in the root layout (next to the PortalHost).
 * `bottomInset` is the distance from the window's bottom edge; the app passes the
 * shell's (`ShellToastHost`), and without one the toasts sit just above the home
 * indicator.
 */
export function ToastHost({ bottomInset }: { bottomInset?: number }) {
  const { t } = useTranslation();
  const items = useToasts((s) => s.items);
  const phone = useLayout() === 'phone';
  const insets = useSafeAreaInsets();
  if (items.length === 0) return null;
  const bottom = bottomInset ?? insets.bottom + 16;
  return (
    <FullWindowOverlay>
      <View
        pointerEvents="box-none"
        className={cn('absolute gap-2.5', phone ? 'left-4 right-4' : 'right-5 w-[380px]')}
        style={{ bottom }}
        // Web/Android announce additions to a polite live region; iOS has none, so each
        // toast announces itself there (ToastCard).
        accessibilityLiveRegion="polite"
        role="status"
        accessibilityLabel={t('ui.toast.region')}
      >
        {items.map((item) => (
          <ToastCard key={item.id} item={item} />
        ))}
      </View>
    </FullWindowOverlay>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { id, title, description, action, onClose, closeLabel } = item;

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(description ? `${title}. ${description}` : title);
    }
  }, [title, description]);

  return (
    <Animated.View
      entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(200).reduceMotion(ReduceMotion.System)}
    >
      <View
        className="flex-row items-start gap-3 rounded-menu bg-primary py-3 pl-3.5 pr-2 shadow-overlay"
        // The web: the timer holds while the pointer is over the toast or focus is in it.
        {...(Platform.OS === 'web'
          ? {
              onPointerEnter: () => pauseToast(id),
              onPointerLeave: () => resumeToast(id),
              onFocus: () => pauseToast(id, 'focus'),
              onBlur: () => resumeToast(id, 'focus'),
            }
          : {})}
      >
        <View className="flex-1 gap-0.5 py-0.5">
          <Text className="font-sans-bold text-sm text-primary-foreground">{title}</Text>
          {description ? (
            <Text className="font-sans text-xs text-primary-muted-foreground">{description}</Text>
          ) : null}
        </View>
        {action ? (
          <Pressable
            role="button"
            onPress={() => {
              dismissToast(id);
              action.onPress();
            }}
            hitSlop={8}
            className={cn(
              'rounded-lg bg-primary-foreground/15 px-2.5 py-1.5 active:bg-primary-foreground/25',
              Platform.select({
                web: `cursor-pointer hover:bg-primary-foreground/25 ${FOCUS_RING_CLASS}`,
              }),
            )}
          >
            <Text className="font-sans-bold text-xs text-primary-foreground">{action.label}</Text>
          </Pressable>
        ) : null}
        <Pressable
          role="button"
          accessibilityLabel={closeLabel ?? t('ui.toast.dismiss')}
          onPress={() => {
            dismissToast(id);
            onClose?.();
          }}
          // A 1.75 rem circle, its touch grown to the minimum target.
          hitSlop={slopTo44(1.75)}
          className={cn(
            'h-7 w-7 items-center justify-center rounded-full active:bg-primary-foreground/15',
            Platform.select({
              web: `cursor-pointer hover:bg-primary-foreground/15 ${FOCUS_RING_CLASS}`,
            }),
          )}
        >
          <Icon name="close" size={14} color={themed.primaryForeground} />
        </Pressable>
      </View>
    </Animated.View>
  );
}
