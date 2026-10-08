import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, TextInput, View, type HostInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo } from '@/components/brand/logo';
import { Input, type InputProps } from '@/components/ui/input';
import { SafeAreaView } from '@/components/ui/safe-area-view';
import { Text } from '@/components/ui/text';
import { keyboardLift, useKeyboardFrame } from '@/lib/keyboard-lift';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';

import {
  CONNECT_STEPS,
  type ConnectStep,
  revealOffset,
  revealSpan,
  type Span,
} from './connect-model';
import { CoverCascadePanel } from './cover-cascade';

/**
 * The frame every connect screen sits in (STYLEGUIDE section 8, "Empty, skeleton, first
 * run"): on a phone one column; on a tablet or desktop two, the steps on the left and the
 * cover cascade panel on the right.
 *
 * The connect screens are full screens, not sheets, so they keep their own fields above
 * the software keyboard. iOS lays the keyboard over the window, and Android edge to edge
 * (SDK 56) no longer resizes the window for it, so the column's scroll view is shortened
 * by what the keyboard covers (`useKeyboardFrame`), and the focused field is scrolled into
 * what is left (`revealOffset`) once the view has shrunk and whenever another field takes
 * the focus. A window that does resize (older Android) reads as covered by nothing, and
 * the web is the browser's business.
 */

type Reveal = () => void;
/** Scroll a view of the column into what the keyboard leaves of it. */
type RevealView = (view: HostInstance | null) => void;

/** How the steps and the cascade panel share the width, per form factor. */
const SHARE = {
  phone: { column: 1, panel: 0 },
  tablet: { column: 3, panel: 2 },
  desktop: { column: 1, panel: 1 },
} as const;

const RevealContext = createContext<Reveal>(() => {});
export const RevealViewContext = createContext<RevealView>(() => {});
/** Keep a shown view (a `ConnectReveal`) in view with the focused field on every later
 * reveal; returns the unregister function. */
export const RevealKeepContext = createContext<(view: HostInstance) => () => void>(() => () => {});

/**
 * Something that appears in a connect column under a field the keyboard is up for (the
 * address probe's "Found Hearthside" with its Sign in): once laid out, it is scrolled into
 * what the keyboard leaves, as a focused field is. Without it the notice's button sat
 * half under the iOS keyboard. While shown it is kept in view with the field on every
 * later reveal too: tapping the field again (the keyboard coming back up) left the notice
 * under the keyboard on the Pixel.
 */
export function ConnectReveal({ children, testID }: { children: ReactNode; testID?: string }) {
  const revealView = useContext(RevealViewContext);
  const keep = useContext(RevealKeepContext);
  const ref = useRef<View>(null);
  useEffect(() => {
    const view = ref.current as unknown as HostInstance | null;
    return view ? keep(view) : undefined;
  }, [keep]);
  return (
    <View
      ref={ref}
      testID={testID}
      onLayout={() =>
        requestAnimationFrame(() => revealView(ref.current as unknown as HostInstance | null))
      }
    >
      {children}
    </View>
  );
}

/** A connect screen's text field: an `Input` that, when it takes the focus, is scrolled
 * into the part of the frame the keyboard leaves (`ConnectFrame`). */
export function ConnectInput({ onFocus, ...props }: InputProps) {
  const reveal = useContext(RevealContext);
  return (
    <Input
      {...props}
      onFocus={(e) => {
        onFocus?.(e);
        reveal();
      }}
    />
  );
}

export function ConnectFrame({
  children,
  centered,
  testID,
}: {
  children: ReactNode;
  /** Centre the column's content (the ready screen). */
  centered?: boolean;
  testID?: string;
}) {
  const layout = useLayout();
  const wide = layout !== 'phone';
  // A tablet gives the steps the larger share (the fields and the segmented control need
  // the room); a desktop splits evenly, as the prototype does.
  const share = SHARE[layout];
  const column = (
    <SafeAreaView
      testID={testID}
      edges={wide ? ['top', 'bottom', 'left'] : ['top', 'bottom', 'left', 'right']}
      style={{ flex: share.column }}
      className="bg-background"
    >
      <KeyboardColumn wide={wide} centered={centered}>
        {children}
      </KeyboardColumn>
    </SafeAreaView>
  );
  if (!wide) return column;
  return (
    <View className="flex-1 flex-row bg-background">
      {column}
      <CoverCascadePanel flex={share.panel} />
    </View>
  );
}

function KeyboardColumn({
  wide,
  centered,
  children,
}: {
  wide: boolean;
  centered?: boolean;
  children: ReactNode;
}) {
  const native = Platform.OS === 'ios' || Platform.OS === 'android';
  const { overlap } = useKeyboardFrame(native);
  const insets = useSafeAreaInsets();
  // The SafeAreaView already pads the home indicator, which the keyboard covers too.
  const pad = keyboardLift(overlap, insets.bottom);
  const scroll = useRef<ScrollView>(null);
  const inner = useRef<View>(null);
  const scrollY = useRef(0);
  const viewport = useRef(0);
  const kept = useRef(new Set<HostInstance>());
  const keep = useCallback((view: HostInstance) => {
    kept.current.add(view);
    return () => void kept.current.delete(view);
  }, []);

  // Scroll a span of the content into the part of the column left visible.
  const scrollToSpan = useCallback((span: Span | null) => {
    if (!span) return;
    const to = revealOffset({
      fieldTop: span.top,
      fieldBottom: span.bottom,
      scrollY: scrollY.current,
      viewport: viewport.current,
    });
    if (to !== null) scroll.current?.scrollTo({ y: to, animated: true });
  }, []);

  // Where `view` sits in the content, or null when it can't be measured.
  const measure = useCallback(
    (view: HostInstance | null): Promise<Span | null> =>
      new Promise((resolve) => {
        const content = inner.current as unknown as HostInstance | null;
        if (!view || !content) return resolve(null);
        view.measureLayout(
          content,
          (_x, top, _w, height) => resolve({ top, bottom: top + height }),
          () => resolve(null),
        );
      }),
    [],
  );

  // Scroll `target` (a field, a notice) into the part of the column left visible.
  const revealView = useCallback<RevealView>(
    (target) => {
      if (!native || !target) return;
      void measure(target).then((span) => scrollToSpan(span));
    },
    [native, measure, scrollToSpan],
  );

  // The focused field, with any shown notice under it (`ConnectReveal`).
  const reveal = useCallback(() => {
    if (!native) return;
    const field = TextInput.State.currentlyFocusedInput?.() as HostInstance | null;
    if (!field) return;
    void Promise.all([measure(field), ...[...kept.current].map(measure)]).then(
      ([own, ...shown]) =>
        own &&
        scrollToSpan(
          revealSpan(
            own,
            shown.filter((s): s is Span => s !== null),
          ),
        ),
    );
  }, [native, measure, scrollToSpan]);

  // A field focused while the keyboard is already up (the password after the username):
  // the view has its size, so reveal on the next frame.
  const revealSoon = useCallback(() => {
    requestAnimationFrame(reveal);
  }, [reveal]);

  return (
    <RevealContext.Provider value={revealSoon}>
      <RevealViewContext.Provider value={revealView}>
        <RevealKeepContext.Provider value={keep}>
          <View style={{ flex: 1, paddingBottom: pad }}>
            <ScrollView
              ref={scroll}
              innerViewRef={inner as React.RefObject<View>}
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={32}
              onScroll={(e) => {
                scrollY.current = e.nativeEvent.contentOffset.y;
              }}
              onLayout={(e) => {
                viewport.current = e.nativeEvent.layout.height;
                // The keyboard just shortened the view: bring the focused field up.
                if (pad > 0) reveal();
              }}
              contentContainerClassName={cn(
                'grow justify-center',
                wide ? 'px-12 py-12' : 'px-5 py-6',
              )}
            >
              <View
                className={cn('w-full max-w-[560px] gap-6 self-center', centered && 'items-center')}
              >
                {children}
              </View>
            </ScrollView>
          </View>
        </RevealKeepContext.Provider>
      </RevealViewContext.Provider>
    </RevealContext.Provider>
  );
}

/** The mark and the wordmark at the top of the first step. */
export function BrandLockup() {
  return (
    <View className="flex-row items-center gap-2.5">
      <View className="h-10 w-10 items-center justify-center rounded-[12px] bg-primary">
        <Logo size={20} />
      </View>
      {/* eslint-disable-next-line i18next/no-literal-string -- brand wordmark, never translated */}
      <Text variant="heading">AudioSilo</Text>
    </View>
  );
}

/** Where the listener is in onboarding: one bar per step, the steps so far in ink. */
export function StepDots({ step }: { step: ConnectStep }) {
  const { t } = useTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t('onboarding.step', { step: step + 1, count: CONNECT_STEPS })}
      className="flex-row gap-1.5"
    >
      {Array.from({ length: CONNECT_STEPS }, (_, i) => (
        <View
          key={i}
          className={cn('h-1 w-7 rounded-full', i <= step ? 'bg-foreground' : 'bg-border-strong')}
        />
      ))}
    </View>
  );
}
