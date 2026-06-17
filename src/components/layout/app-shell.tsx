import { type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from './app-header';
import { NavBar } from './app-nav';

const WIDE_BREAKPOINT = 1024;

/**
 * Responsive chrome around the routed screen:
 * - wide (web/tablet): the old 3-column feel — left sidebar + content (right
 *   detail panel is provided per-screen).
 * - phone: header on top, content, bottom tab bar.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  if (wide) {
    return (
      <View className="flex-1 flex-row bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="sidebar" />
        <View className="flex-1">
          <AppHeader />
          <View className="flex-1">{children}</View>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-200 dark:bg-gray-800">
      <AppHeader />
      <View className="flex-1">{children}</View>
      <SafeAreaView edges={['bottom']} className="bg-gray-200 dark:bg-gray-800">
        <NavBar orientation="bottom" />
      </SafeAreaView>
    </View>
  );
}
