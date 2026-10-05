import { Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MiniPlayer } from '@/components/player/mini-player';
import { ACCESSORY_SUPPORTED } from '@/components/shell/accessory-support';
import {
  rootOfRoute,
  TAB_STACK_SETTINGS,
  tabStackListeners,
} from '@/components/shell/destinations';
import { PhoneHeader } from '@/components/shell/phone-header';
import { useChromeEdge } from '@/components/shell/shell-metrics';
import { useRootFrame } from '@/components/ui/overlay';
import { useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * ONE layout for all five tab stacks: the array group expands it into `(home)`,
 * `(library)`, `(search)`, `(offline)` and `(me)`, each its own Stack, so a pushed detail
 * page keeps the tab bar (and the mini player) under it. The group-keyed
 * `initialRouteName`s give a cold deep link a tab root to go back to.
 *
 * On a phone each page gets the shell's `PhoneHeader` as its Stack header (large title
 * on a tab root, inline back on a pushed page, banners under it); tablet and desktop hide
 * it, the top bar and sub-nav carry that instead.
 */
export const unstable_settings = TAB_STACK_SETTINGS;

export default function TabStackLayout() {
  const { t } = useTranslation();
  const { background } = useThemeColors();
  const phone = useLayout() === 'phone';
  const insets = useSafeAreaInsets();
  // Native phone without a bottom accessory (Android, iOS < 26): the mini player floats
  // as a card above the native tab bar. iOS lays the screen out under its (translucent)
  // bar, so the safe-area bottom inset there is the bar; Android insets the screen
  // content above its bar already. (Web places its own above its tab bar.)
  const floatCard = Platform.OS !== 'web' && !ACCESSORY_SUPPORTED && phone;

  // The native tab bar's top edge, for the root toasts (web's own bar publishes itself):
  // iOS lays the page out under its translucent bar, so the bar is the bottom safe-area
  // inset here; Android lays it out above its bar, so the bar is what lies below the page
  // in the window.
  const native = Platform.OS !== 'web';
  const rootHeight = useRootFrame().height;
  const page = useRef<View>(null);
  const [below, setBelow] = useState(0);
  const measure = () =>
    page.current?.measureInWindow((_x, y, _w, h) => setBelow(Math.max(0, rootHeight - (y + h))));
  useChromeEdge('bar', phone ? Math.max(insets.bottom, below) : undefined, native);

  return (
    <View ref={page} onLayout={native ? measure : undefined} style={{ flex: 1 }}>
      <Stack
        screenListeners={tabStackListeners}
        screenOptions={({ route }) => {
          const root = rootOfRoute(route.name);
          return {
            title: root ? t(root.titleKey) : '',
            headerShown: phone,
            header: ({ back, options, navigation }) => (
              <PhoneHeader
                title={typeof options.title === 'string' ? options.title : ''}
                // A tab root never goes back: React Navigation would otherwise pass
                // a parent navigator's back (the root stack under a modal flow).
                backTitle={root || !back ? undefined : (back.title ?? '')}
                onBack={navigation.goBack}
              />
            ),
            contentStyle: { backgroundColor: background },
          };
        }}
      />
      {floatCard ? (
        <MiniPlayer bottomOffset={Platform.OS === 'android' ? 0 : insets.bottom} />
      ) : null}
    </View>
  );
}
