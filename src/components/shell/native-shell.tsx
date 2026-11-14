import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { FloatingMiniPlayer } from '@/components/player/mini-player';

import { AccessoryPlayer } from '@/components/shell/accessory-player';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import { ShellPlayerOverlays } from '@/components/player/player-sheet-host';
import { AuthGate } from '@/components/shell/auth-gate';
import { useBehindModalProps } from '@/components/ui/modal-layer';
import { TABS } from '@/components/shell/destinations';
import { tabLabelFontSize } from '@/components/shell/tab-label-size';
import { ShellFrame } from '@/components/shell/shell-frame';
import { useIsTopShell } from '@/components/shell/top-shell';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { useLayout } from '@/lib/layout';
import { useFontScale, useLargeText } from '@/lib/text-scale';
import { useEpisodeFetch } from '@/playback/episode-fetch';
import { usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The scale the Android tab bar's labels follow; `null` elsewhere, so iOS doesn't redraw
 * the shell on every text-size step (it needs only `useLargeText`'s threshold). Chosen
 * once per platform, so the hook order never changes. */
const useTabLabelScale: () => number | null = Platform.OS === 'android' ? useFontScale : () => null;

/**
 * The native (iOS/Android) shell: ONE navigator, NativeTabs, at every width - only the
 * chrome around it changes, so crossing 640 (iPad rotation, split view) keeps every
 * tab's stack. Phone: the native tab bar, with the mini player in its bottom accessory
 * (iOS 26) or ONE card floating above it (`FloatingMiniPlayer`, over NativeTabs - not one
 * per tab stack: NativeTabs keeps visited tabs alive). Tablet/desktop: the tab bar is
 * hidden and our top bar, sub-nav and docked player bar take over. Tabs are never added
 * or removed at runtime (NativeTabs can't), only hidden as a whole.
 *
 * The web shell is `src/app/(app)/_layout.web.tsx`, over the same route groups.
 */
function NativeShell() {
  useShellEffects();
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const themed = useThemeColors();
  const wide = useLayout() !== 'phone';
  const loaded = usePlayer((s) => s.nowPlaying != null);
  // An episode on its way shows in the accessory too, with nothing playing yet.
  const fetching = useEpisodeFetch((s) => s.pending !== null);
  const top = useIsTopShell();
  // Android: at the large text sizes five labels don't fit their slots ("Ho...", "Libr...").
  // Material's answer is the chosen tab's label only (the others keep theirs for TalkBack),
  // and the label stops growing at 1.3x so even that one fits (`tab-label-size.ts`).
  const large = useLargeText();
  const tabScale = useTabLabelScale();
  const labelStyle = useMemo(
    () => (tabScale === null ? undefined : { fontSize: tabLabelFontSize(tabScale) }),
    [tabScale],
  );

  // React Navigation's theme, from ours: the native tab and stack containers paint with
  // it (on iOS 26 a missing theme shows default-white artifacts in tab transitions).
  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: themed.brand,
        background: themed.background,
        card: themed.card,
        text: themed.foreground,
        border: themed.border,
      },
    };
  }, [scheme, themed]);

  return (
    <ThemeProvider value={navTheme}>
      {/* The player's overlays (its sheets, Up next's) render in place, over the whole shell. */}
      <View style={{ flex: 1 }}>
        <BehindSheets>
          <ShellFrame
            // Absolutely positioned in the frame, which spans the window: its bottom offset is
            // the native bar's measured top edge, so it sits on the bar on every tab and over a
            // pushed page, and a tab switch never remounts it.
            phoneBottom={ACCESSORY_SUPPORTED ? null : <FloatingMiniPlayer />}
          >
            <NativeTabs
              hidden={wide}
              tintColor={themed.brand}
              // Android (Material 3, STYLEGUIDE section 10): every tab labelled, the
              // active one on a brand-soft pill; under large text the active one only.
              labelVisibilityMode={large ? 'selected' : 'labeled'}
              labelStyle={labelStyle}
              indicatorColor={themed.brandSoft}
              minimizeBehavior="onScrollDown"
              unstable_nativeProps={{
                ios: { bottomAccessoryHidden: !(loaded || fetching) || wide },
              }}
            >
              {TABS.map((d) => (
                <NativeTabs.Trigger
                  key={d.name}
                  name={d.name}
                  role={d.name === '(search)' ? 'search' : undefined}
                >
                  <NativeTabs.Trigger.Icon sf={d.sf} md={d.md} />
                  <NativeTabs.Trigger.Label>{t(d.labelKey)}</NativeTabs.Trigger.Label>
                </NativeTabs.Trigger>
              ))}
              {ACCESSORY_SUPPORTED ? (
                <NativeTabs.BottomAccessory>
                  <AccessoryPlayer />
                </NativeTabs.BottomAccessory>
              ) : null}
            </NativeTabs>
          </ShellFrame>
        </BehindSheets>
        {/* In the top shell only, should a second one ever be stacked over this one. */}
        {top ? <ShellPlayerOverlays /> : null}
      </View>
    </ThemeProvider>
  );
}

/**
 * The shell under the sheets: hidden from VoiceOver and TalkBack while one is open. A
 * component of its own, so a sheet opening or closing re-renders this frame alone (its
 * children are the same elements), not the shell and its tabs.
 */
function BehindSheets({ children }: { children: ReactNode }) {
  return (
    <View style={{ flex: 1 }} {...useBehindModalProps()}>
      {children}
    </View>
  );
}

/**
 * The `(app)` group's layout on iOS and Android (`src/app/(app)/_layout.tsx` re-exports it).
 * It lives here, not in the route file, so the web build never evaluates it: Expo Router
 * loads EVERY layout file of a group, the platform one and the plain one alike, to read
 * their settings, and on the web this module is `native-shell.web.tsx`'s empty stand-in.
 */
export function NativeAppShell() {
  return (
    <AuthGate>
      <NativeShell />
    </AuthGate>
  );
}
