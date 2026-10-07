import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BackHandler,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';

import { Icon } from './icon';
import { OverlayHost } from './overlay-host';
import { Text } from './text';

const ANIM_MS = 200;
/** A tablet's sheet floats at this width (STYLEGUIDE section 8, "Sheets"). */
const TABLET_SHEET_WIDTH = 560;

export type SheetProps = {
  /** Whether the sheet is shown. Toggling this drives the enter/exit animation. */
  visible: boolean;
  /** Called when the backdrop is pressed or Android hardware back is used. */
  onClose: () => void;
  /** Optional header title; when set, a header row with a close button is rendered. */
  title?: string;
  children: ReactNode;
  /** Cap the panel height at this fraction of the window height (default 0.85). */
  maxHeightFraction?: number;
  /**
   * Render the overlay directly (absolute `inset-0`), owning its own Android
   * hardware-back, instead of routing it through an `OverlayHost`. The player's
   * sheets pass `inline` because they mount at the player-view root and manage
   * dismissal there. Defaults to `false` (hosted mode), where the `OverlayHost`
   * owns Escape/back. Both modes render in place, so either way the Sheet must be
   * mounted at screen level (never inside a card/Pressable) - see `OverlayHost`.
   */
  inline?: boolean;
  /** The body scrolls inside the panel's height cap (its content padded by
   * `contentClassName`), so the caller needs no measured max height of its own. */
  scroll?: boolean;
  contentClassName?: string;
};

/**
 * A bottom sheet: a fading backdrop plus a panel that slides up on open and down on
 * close. Our own reanimated animation drives both; the `OverlayHost` (default mode) is
 * only the dismissal host, so it never competes with the slide/fade. Styled to Stacks
 * (STYLEGUIDE.md section 8: `popover` panel, radius 24, grabber, the `overlay` scrim).
 *
 * Still hand-rolled (player redesign 0b), not the guide's `@expo/ui` BottomSheet: that
 * hosts React Native content inside a SwiftUI/Compose sheet through `RNHostView`, and
 * these sheets hold text inputs (bookmarks, notes), a FlatList scrolled to the current
 * chapter and measured max heights, and open over the iOS `fullScreenModal` player -
 * none of which can be verified without a device. Its web build (vaul) also paints a
 * fixed white/black panel from the OS scheme, not the app theme. The player phase that
 * redesigns these sheets is the place to move them, on a device.
 *
 * Both modes render the overlay IN PLACE (an absolute `inset-0` View) - an RN `Modal`
 * renders nothing on web in this stack, and this Sheet predates the portal primitives
 * (see `OverlayHost` for why portals looked broken here and now work). So the Sheet MUST
 * be mounted at screen level (never inside a card/Pressable/clipped container)
 * regardless of mode.
 * Two presentation modes differ only in who owns dismissal:
 * - **Hosted (default):** wraps the overlay in an `OverlayHost`, which owns Android
 *   hardware-back and web Escape - so the manual BackHandler below must NOT also run.
 * - **Inline (`inline`):** renders the overlay directly with its own Android
 *   BackHandler. The player's sheets pass `inline` and mount at the player-view root.
 *
 * On a tablet a hosted sheet floats at 560 wide; the player's inline sheets keep the full
 * width (their redesign is a later phase).
 *
 * Children unmount only after the exit animation finishes (the host stays mounted
 * until then, so the slide-down is seen). Reduced motion collapses to an instant
 * show/hide. Backdrop press and Android hardware back both close it.
 *
 * ALL mount state changes in effects, never during render. An earlier version
 * adjusted the mount flag during render (React's "adjust state during render"
 * pattern) and flipped it back to false from the exit-animation callback. Under
 * React 19's concurrent rendering the production web build REPLAYS renders and
 * DISCARDS render-phase state updates (a live trace showed the render-phase
 * `setRendered(true)` rolled back with no setter call between renders), so opening
 * a non-inline sheet mounted nothing. The mount condition now derives opening
 * purely from the `visible` prop (`mounted = visible || exiting`), so a
 * lost/replayed state update can never suppress the open; the only state
 * (`exiting`) is written from effects, and a dropped `exiting` write degrades only
 * the slide-down animation (the sheet closes instantly), never correctness.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  maxHeightFraction = 0.85,
  inline = false,
  scroll = false,
  contentClassName,
}: SheetProps) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const layout = useLayout();
  const floating = !inline && layout === 'tablet';
  const neutral = themed.foreground;

  // Keep the panel mounted through the exit animation. Opening depends ONLY on the
  // `visible` prop; `exiting` extends the mount past a close until the slide-down
  // finishes. Both drive `mounted` below.
  const [exiting, setExiting] = useState(false);
  const mounted = visible || exiting;
  // Whether the sheet has ever been open; gates the exit branch so a first mount
  // with `visible={false}` doesn't flash-mount to animate a close that never opened.
  const wasVisible = useRef(visible);
  // 0 = fully closed (offscreen), 1 = fully open.
  const progress = useSharedValue(visible ? 1 : 0);
  // Measured panel height, in px; seeded with the window height so the closed
  // position is offscreen before the first layout pass.
  const panelHeight = useSharedValue(height);

  // The single mount-state driver - runs in an effect (never during render) so a
  // concurrent render replay can't discard the update (see the component doc).
  useEffect(() => {
    if (visible) {
      // Opening: `mounted` is already true via the `visible` prop, so nothing to
      // set here - just run the enter animation. (A stale `exiting` left over from
      // reopening mid-exit is harmless: `visible` keeps it mounted, and the next
      // close resets it.)
      wasVisible.current = true;
      progress.value = reduced
        ? 1
        : withTiming(1, { duration: ANIM_MS, easing: Easing.out(Easing.cubic) });
      return;
    }
    // A close that never followed an open must not flash-mount to animate nothing.
    if (!wasVisible.current) return;
    wasVisible.current = false;
    // Reduced motion unmounts at once (exiting -> false); otherwise keep it mounted
    // (exiting -> true) through the slide-down, which the animation callback ends.
    // This write reacts to `visible` so it must live in the effect, and it must be
    // synchronous: deferring it would flash-unmount before the animation, and a
    // render-phase write is exactly the update React 19 rolls back (the bug this
    // rewrite fixes).
    setExiting(!reduced);
    if (reduced) {
      progress.value = 0;
      return;
    }
    progress.value = withTiming(
      0,
      { duration: ANIM_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(setExiting)(false);
      },
    );
  }, [visible, reduced, progress]);

  // Hardware back closes the sheet (Android only fires this event); registered
  // only while visible so it doesn't shadow other back handlers when closed. In
  // hosted (default) mode the OverlayHost owns hardware-back, so this manual handler
  // runs in inline mode only (otherwise it would fire twice / double-close).
  useEffect(() => {
    if (!inline || !visible || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [inline, visible, onClose]);

  // Fades the themed `overlay` scrim in (Stacks: a translucent ink, deeper in dark).
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * panelHeight.value }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    panelHeight.value = e.nativeEvent.layout.height;
  };

  if (!mounted) return null;

  const overlay = (
    <View
      className="absolute inset-0 justify-end"
      pointerEvents="box-none"
      // Web: a hosted sheet is a modal layer (the player's keyboard shortcuts stand back
      // while one is open, and its OverlayHost owns Escape). An inline sheet is driven by
      // its caller's state (the player's sheets: the shortcuts close those themselves).
      {...(!inline && Platform.OS === 'web' ? { role: 'dialog' as const, 'aria-modal': true } : {})}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: themed.overlay }, backdropStyle]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
      </Animated.View>
      <Animated.View
        style={[
          panelStyle,
          floating ? { width: '100%', maxWidth: TABLET_SHEET_WIDTH, alignSelf: 'center' } : null,
        ]}
        onLayout={onLayout}
      >
        <View
          className="rounded-t-sheet border-t border-border bg-popover shadow-overlay"
          style={{
            maxHeight: Math.round(height * maxHeightFraction),
            paddingBottom: insets.bottom,
          }}
        >
          {/* The grabber (decorative: the backdrop, the close button and back dismiss). */}
          <View
            className="mb-0.5 mt-2 h-[5px] w-[38px] self-center rounded-full bg-border-strong"
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
          {title ? (
            <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
              <Text variant="title">{title}</Text>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                className="h-9 w-9 items-center justify-center rounded-full active:bg-accent"
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Icon name="close" size={20} color={neutral} />
              </Pressable>
            </View>
          ) : null}
          {scroll ? (
            // Shrinks to the panel's cap and scrolls the rest.
            <ScrollView style={{ flexShrink: 1 }} contentContainerClassName={contentClassName}>
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </View>
      </Animated.View>
    </View>
  );

  // Inline mode: the caller owns dismissal (e.g. the iOS player modal, whose sheets
  // mount at the player-view root). Render the overlay directly.
  if (inline) return overlay;

  // Hosted mode (default): wrap the overlay in an OverlayHost, which owns Android
  // hardware-back and web Escape (an RN Modal renders nothing on web in this stack).
  // The overlay still renders in place, so - like inline mode - the Sheet must be
  // mounted at screen level. The host stays mounted until `mounted` flips false
  // (after the exit animation), so the slide-down is seen.
  return (
    <OverlayHost visible={mounted} onRequestClose={onClose}>
      {overlay}
    </OverlayHost>
  );
}
