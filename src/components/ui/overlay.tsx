import {
  createContext,
  Fragment,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Platform, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import {
  type EdgeInsets,
  type Rect,
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
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

const RootInsetsContext = createContext<{ insets: EdgeInsets; frame: Rect } | null>(null);

/**
 * Captures the ROOT safe-area insets for the overlays. Mount it once, directly inside the
 * root `SafeAreaProvider` (src/app/_layout.tsx). Overlays cover the whole window, so their
 * frame must use the window's insets wherever they are called from: a tab screen's own
 * safe-area context counts the native tab bar in `insets.bottom`, which made a phone
 * sheet opened from a tab ~100pt too tall on iOS and pushed menus up off the bar. It also
 * holds the root frame (the window), for the shell's chrome measurements.
 */
export function RootInsetsProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const value = useMemo(() => ({ insets, frame }), [insets, frame]);
  return <RootInsetsContext.Provider value={value}>{children}</RootInsetsContext.Provider>;
}

/** The root safe-area insets (`RootInsetsProvider`); the nearest context's outside it (an
 * isolated test render). */
export function useRootInsets(): EdgeInsets {
  const local = useSafeAreaInsets();
  return useContext(RootInsetsContext)?.insets ?? local;
}

/** The root frame, i.e. the window (`RootInsetsProvider`); the nearest context's outside it. */
export function useRootFrame(): Rect {
  const local = useSafeAreaFrame();
  return useContext(RootInsetsContext)?.frame ?? local;
}

/**
 * The safe-area insets for a positioned overlay (Popover, Select, DropdownMenu,
 * Tooltip): rn-primitives keeps native content inside these when it flips or clamps
 * against the screen edge, so a menu never slides under the notch or the home bar.
 * The root's insets, so any call site gets the same answer. Web ignores them.
 */
export function useOverlayInsets() {
  const insets = useRootInsets();
  return {
    top: insets.top + 8,
    bottom: insets.bottom + 8,
    left: insets.left + 8,
    right: insets.right + 8,
  };
}

/**
 * Wraps an rn-primitives Content part so its `style` always arrives as ONE flat object.
 * On web, rn-primitives hands Content's props to a Radix DOM node through a Slot that
 * merges `style` by object spread: an array turned into `{0: ..., 1: ...}` and crashed
 * react-native-web's style setter. Every overlay's Content part goes through this, so a
 * caller (or a frame) can pass an ordinary style array.
 */
export function withFlatStyle<P extends { style?: StyleProp<ViewStyle> }>(
  Content: ComponentType<P>,
): ComponentType<P> {
  function FlatStyleContent(props: P) {
    return (
      <Content
        {...props}
        style={props.style == null ? undefined : StyleSheet.flatten(props.style)}
      />
    );
  }
  FlatStyleContent.displayName = `FlatStyle(${Content.displayName ?? Content.name ?? 'Content'})`;
  return FlatStyleContent;
}
