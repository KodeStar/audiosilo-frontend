import { Link, usePathname, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { Brand } from '@/components/brand/brand';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { engine } from '@/downloads/engine';
import { useSession } from '@/stores/session';
import { colors } from '@/theme/tokens';

type NavItem = { href: Href; match: string; label: string; icon: IconName };

// Search lives in the header (phone) / top bar (desktop), not the tab bar.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', match: '/', label: 'Home', icon: 'home' },
  { href: '/library', match: '/library', label: 'Library', icon: 'library' },
  // Downloads are native-only (no web offline storage until the M4 service worker).
  ...(engine.supported ? [{ href: '/downloads', match: '/downloads', label: 'Downloads', icon: 'download' } as NavItem] : []),
  { href: '/settings', match: '/settings', label: 'Settings', icon: 'settings' },
];

function isActive(pathname: string, match: string) {
  return match === '/' ? pathname === '/' : pathname === match || pathname.startsWith(`${match}/`);
}

/** Left sidebar on wide screens, bottom tab bar on phones. */
export function NavBar({ orientation }: { orientation: 'sidebar' | 'bottom' }) {
  const pathname = usePathname();
  const api = useOptionalApi();
  const logout = useSession((s) => s.logout);

  const onLogout = async () => {
    try {
      await api?.logout();
    } catch {
      // ignore; clear locally regardless
    }
    await logout();
  };

  if (orientation === 'bottom') {
    return (
      <View className="flex-row border-t border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.match);
          return (
            <Link key={item.match} href={item.href} asChild>
              <Pressable className="flex-1 items-center justify-center gap-1 py-2.5">
                <Icon name={item.icon} size={24} color={active ? colors.primary : colors.dark.textMuted} />
                <Text className={`text-[11px] ${active ? 'text-primary' : 'text-gray-500 dark:text-gray-400'}`}>
                  {item.label}
                </Text>
              </Pressable>
            </Link>
          );
        })}
      </View>
    );
  }

  return (
    <View className="w-80 border-r border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800 after:content-[''] after:border-r after:border-gray-100 after:dark:border-gray-750">
      <View className="p-5">
        <Brand size={50} showVersion />
      </View>
      <View className="gap-2 px-3">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.match);
          return (
            <Link key={item.match} href={item.href} asChild>
              <Pressable
                className={`relative flex-row items-center gap-3 rounded-lg border px-4 py-3 ${
                  active
                    ? 'border-gray-200 bg-gray-50 shadow-sm dark:border-gray-860 dark:bg-gray-840 dark:shadow-none'
                    : 'border-transparent active:bg-gray-50 dark:active:bg-gray-840'
                }`}
              >
                {active ? (
                  <View className="absolute -left-2 bottom-1 top-1 w-1.5 rounded-full bg-primary" />
                ) : null}
                <Icon name={item.icon} size={20} color={colors.dark.text} />
                <Text className="text-base text-gray-600 dark:text-gray-300">{item.label}</Text>
              </Pressable>
            </Link>
          );
        })}
      </View>

      <View className="flex-1" />

      <Pressable
        onPress={onLogout}
        className="flex-row items-center gap-3 border-t border-gray-100 px-6 py-5 active:bg-gray-50 dark:border-gray-750 dark:active:bg-gray-840"
      >
        <Icon name="logout" size={20} color={colors.dark.text} />
        <Text className="text-base text-gray-600 dark:text-gray-300">Logout</Text>
      </Pressable>
    </View>
  );
}
