import { Fragment, type ReactNode } from 'react';
import { Platform, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';

/**
 * Shared plumbing for the portal-based overlays (Dialog, AlertDialog, Select, Popover,
 * DropdownMenu, Tooltip), from react-native-reusables.
 *
 * The overlays portal into the root `<PortalHost />` (src/app/_layout.tsx) on native and
 * into `document.body` on web (Radix), so unlike the old in-place `OverlayHost` they can
 * be opened from inside a card or a ScrollView.
 */

/**
 * iOS: lifts portaled content into its own window above every native screen. Without
 * it a Select opened inside the player's `fullScreenModal` rendered BEHIND the modal
 * (player redesign Phase 0a spike). A plain Fragment elsewhere.
 */
export const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : Fragment;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type AnimatedViewProps = Omit<React.ComponentProps<typeof Animated.View>, 'key'> & {
  as?: 'View';
};
type AnimatedPressableProps = Omit<React.ComponentProps<typeof AnimatedPressable>, 'key'> & {
  as: 'Pressable';
};

/**
 * Reanimated enter/exit layout animations on native; the bare children on web (the web
 * overlays animate with CSS classes instead). Callers pass `.reduceMotion(System)` on
 * every animation so the OS reduce-motion setting turns them into instant changes.
 */
export function NativeOnlyAnimatedView(props: AnimatedViewProps | AnimatedPressableProps) {
  if (Platform.OS === 'web') return <>{props.children as ReactNode}</>;
  if (props.as === 'Pressable') {
    const { as: _as, ...rest } = props;
    return <AnimatedPressable {...rest} />;
  }
  const { as: _as, ...rest } = props;
  return <Animated.View {...rest} />;
}

/**
 * The safe-area insets for a positioned overlay (Popover, Select, DropdownMenu,
 * Tooltip): rn-primitives keeps native content inside these when it flips or clamps
 * against the screen edge, so a menu never slides under the notch or the home bar.
 * Web ignores them.
 */
export function useOverlayInsets() {
  const insets = useSafeAreaInsets();
  return {
    top: insets.top + 8,
    bottom: insets.bottom + 8,
    left: insets.left + 8,
    right: insets.right + 8,
  };
}
