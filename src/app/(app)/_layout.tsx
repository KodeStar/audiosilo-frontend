import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FloatingMiniPlayer } from '@/components/player/mini-player';

import { AccessoryPlayer } from '@/components/shell/accessory-player';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import { ShellPlayerOverlays } from '@/components/player/player-sheet-host';
import { AuthGate } from '@/components/shell/auth-gate';
import { TABS } from '@/components/shell/destinations';
import { ShellFrame } from '@/components/shell/shell-frame';
import { useIsTopShell } from '@/components/shell/top-shell';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The native (iOS/Android) shell: ONE navigator, NativeTabs, at every width - only the
 * chrome around it changes, so crossing 640 (iPad rotation, split view) keeps every
 * tab's stack. Phone: the native tab bar, with the mini player in its bottom accessory
 * (iOS 26) or ONE card floating above it (`FloatingMiniPlayer`, over NativeTabs - not one
 * per tab stack: NativeTabs keeps visited tabs alive). Tablet/desktop: the tab bar is
 * hidden and our top bar, sub-nav and docked player bar take over. Tabs are never added
 * or removed at runtime (NativeTabs can't), only hidden as a whole.
 *
 * The web shell is `_layout.web.tsx`, over the same route groups.
 */
function NativeShell() {
  useShellEffects();
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const themed = useThemeColors();
  const wide = useLayout() !== 'phone';
  const loaded = usePlayer((s) => s.nowPlaying != null);
  const top = useIsTopShell();

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
            // active one on a brand-soft pill.
            labelVisibilityMode="labeled"
            indicatorColor={themed.brandSoft}
            minimizeBehavior="onScrollDown"
            unstable_nativeProps={{ ios: { bottomAccessoryHidden: !loaded || wide } }}
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
        {/* In the top shell only, should a second one ever be stacked over this one. */}
        {top ? <ShellPlayerOverlays /> : null}
      </View>
    </ThemeProvider>
  );
}

export default function AppGroupLayout() {
  return (
    <AuthGate>
      <NativeShell />
    </AuthGate>
  );
}
