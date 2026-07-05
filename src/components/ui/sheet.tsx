import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BackHandler,
  type LayoutChangeEvent,
  Modal,
  Platform,
  Pressable,
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

import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

import { Icon } from './icon';
import { Text } from './text';

const ANIM_MS = 200;

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
   * Render the overlay inline (absolute `inset-0`) instead of inside an RN `Modal`.
   * Required when mounting inside the iOS full-screen player modal, where a nested
   * RN Modal won't present (Modal-in-Modal). Defaults to `false` (Modal mode), which
   * always covers the full window regardless of where the Sheet is mounted - so a
   * card/row-level consumer isn't clipped to its container.
   */
  inline?: boolean;
};

/**
 * A bottom sheet: a fading backdrop plus a panel that slides up on open and down on
 * close. Our own reanimated animation drives both; the RN `Modal` (default mode) is
 * only the full-window host, run with `animationType="none"` so it never competes
 * with the slide/fade.
 *
 * Two presentation modes:
 * - **Modal (default):** wraps the overlay in an RN `<Modal transparent>` so it always
 *   covers the full window no matter where it's mounted - a card/row consumer's Sheet
 *   won't be clipped to the container. Android hardware-back comes from the Modal's
 *   `onRequestClose` (a Modal swallows the key event, so the manual BackHandler must
 *   NOT also run here).
 * - **Inline (`inline`):** renders the absolute `inset-0` overlay directly, with the
 *   manual Android BackHandler. Needed because an RN Modal cannot present inside the
 *   iOS full-screen player modal (Modal-in-Modal won't show on iOS) - the player's
 *   sheets pass `inline` and mount at the player view root.
 *
 * Children unmount only after the exit animation finishes (in Modal mode the Modal
 * stays visible until then, so the slide-down is seen). Reduced motion collapses to
 * an instant show/hide. Backdrop press and Android hardware back both close it.
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  maxHeightFraction = 0.85,
  inline = false,
}: SheetProps) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;

  // Keep the panel rendered through the exit animation; unmount once it completes.
  const [rendered, setRendered] = useState(visible);
  const [prevVisible, setPrevVisible] = useState(visible);
  // 0 = fully closed (offscreen), 1 = fully open.
  const progress = useSharedValue(visible ? 1 : 0);
  // Measured panel height, in px; seeded with the window height so the closed
  // position is offscreen before the first layout pass.
  const panelHeight = useSharedValue(height);

  // Adjust the mount flag during render (React's sanctioned pattern) rather than in
  // an effect: showing mounts immediately; a reduced-motion hide unmounts at once;
  // an animated hide keeps it mounted and the exit animation's completion callback
  // (below) unmounts it.
  if (visible !== prevVisible) {
    setPrevVisible(visible);
    if (visible) setRendered(true);
    else if (reduced) setRendered(false);
  }

  useEffect(() => {
    if (visible) {
      progress.value = reduced
        ? 1
        : withTiming(1, { duration: ANIM_MS, easing: Easing.out(Easing.cubic) });
    } else if (reduced) {
      progress.value = 0;
    } else {
      progress.value = withTiming(
        0,
        { duration: ANIM_MS, easing: Easing.out(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setRendered)(false);
        },
      );
    }
  }, [visible, reduced, progress]);

  // Hardware back closes the sheet (Android only fires this event); registered
  // only while visible so it doesn't shadow other back handlers when closed. In
  // Modal mode the RN Modal swallows the back key and routes it through
  // `onRequestClose` instead, so this manual handler runs in inline mode only
  // (otherwise it would fire twice / shadow the Modal's own handling).
  useEffect(() => {
    if (!inline || !visible || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [inline, visible, onClose]);

  // Fades to bg-black/40 (0.4) at fully open, not solid black.
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.4 }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * panelHeight.value }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    panelHeight.value = e.nativeEvent.layout.height;
  };

  if (!rendered) return null;

  const overlay = (
    <View className="absolute inset-0 justify-end" pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: '#000000' }, backdropStyle]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
      </Animated.View>
      <Animated.View style={panelStyle} onLayout={onLayout}>
        <View
          className="rounded-t-2xl bg-white shadow-lg dark:border-t dark:border-gray-750 dark:bg-gray-840 dark:shadow-none"
          style={{
            maxHeight: Math.round(height * maxHeightFraction),
            paddingBottom: insets.bottom,
          }}
        >
          {title ? (
            <View className="flex-row items-center justify-between px-4 pb-2 pt-4">
              <Text variant="title">{title}</Text>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                className="h-8 w-8 items-center justify-center"
                accessibilityRole="button"
                accessibilityLabel={t('common.close')}
              >
                <Icon name="close" size={22} color={neutral} />
              </Pressable>
            </View>
          ) : null}
          {children}
        </View>
      </Animated.View>
    </View>
  );

  // Inline mode: the caller has mounted us at a top-level position (e.g. the iOS
  // player modal, where a nested Modal can't present). Render the overlay directly.
  if (inline) return overlay;

  // Modal mode (default): host the overlay in a full-window transparent Modal so it
  // covers the whole screen regardless of mount point. `animationType="none"` leaves
  // the slide/fade to our reanimated animation; the Modal stays `visible` until
  // `rendered` flips false (after the exit animation), so the slide-down is seen.
  return (
    <Modal
      transparent
      statusBarTranslucent
      visible={rendered}
      animationType="none"
      onRequestClose={onClose}
    >
      {overlay}
    </Modal>
  );
}
