import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessoryPlayer } from '@/components/shell/accessory-player';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import { AuthGate } from '@/components/shell/auth-gate';
import { TABS } from '@/components/shell/destinations';
import { DockedPlayer } from '@/components/shell/docked-player';
import { DrawerSlot } from '@/components/shell/drawer-slot';
import { useShellEffects } from '@/components/shell/use-shell-effects';
import { WideTop } from '@/components/shell/wide-top';
import { useLayout } from '@/lib/layout';
import { usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The native (iOS/Android) shell: ONE navigator, NativeTabs, at every width - only the
 * chrome around it changes, so crossing 640 (iPad rotation, split view) keeps every
 * tab's stack. Phone: the native tab bar, with the mini player in its bottom accessory
 * (iOS 26) or floating above it (the tab stacks' layout). Tablet/desktop: the tab bar is
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
  const layout = useLayout();
  const wide = layout !== 'phone';
  const loaded = usePlayer((s) => s.nowPlaying != null);

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
      <View className="flex-1 bg-background">
        {wide ? <WideTop /> : null}
        <View className="flex-1 flex-row">
          <View className="flex-1 items-center">
            <View className="w-full max-w-[1480px] flex-1">
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
            </View>
          </View>
          {layout === 'desktop' ? <DrawerSlot /> : null}
        </View>
        {wide ? <DockedPlayer /> : null}
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
