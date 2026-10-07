import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon } from './icon';
import { FullWindowOverlay } from './overlay';
import { FOCUS_RING_CLASS, Text } from './text';

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
 */
export type ToastOptions = {
  title: string;
  description?: string;
  /** At most one action ("Undo", "Add note", "Show"); pressing it also dismisses. */
  action?: { label: string; onPress: () => void };
  /** Milliseconds on screen (default 5s, 8s with an action so it can be reached). */
  duration?: number;
};

type ToastItem = ToastOptions & { id: number };

/** Older toasts beyond this are dropped: a stack, not a log. */
const MAX_VISIBLE = 3;

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Cancels a toast's auto-dismiss timer, if it still has one. */
function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

/** Removes a toast (a no-op when it has already gone). */
export function dismissToast(id: number) {
  clearTimer(id);
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

/** Shows a toast and returns its id (for an early `dismissToast`). */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  const duration = options.duration ?? (options.action ? 8000 : 5000);
  useToasts.setState((s) => {
    const items = [...s.items, { ...options, id }];
    for (const old of items.slice(0, Math.max(0, items.length - MAX_VISIBLE))) clearTimer(old.id);
    return { items: items.slice(-MAX_VISIBLE) };
  });
  timers.set(
    id,
    setTimeout(() => dismissToast(id), duration),
  );
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
  const { id, title, description, action } = item;

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
      <View className="flex-row items-start gap-3 rounded-menu bg-primary py-3 pl-3.5 pr-2 shadow-overlay">
        <View className="flex-1 gap-0.5 py-0.5">
          <Text className="font-sans-bold text-sm text-primary-foreground">{title}</Text>
          {description ? (
            <Text className="font-sans text-xs text-primary-foreground/75">{description}</Text>
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
          accessibilityLabel={t('ui.toast.dismiss')}
          onPress={() => dismissToast(id)}
          hitSlop={8}
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
