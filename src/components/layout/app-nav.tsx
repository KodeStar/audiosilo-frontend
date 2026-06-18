import { Link, usePathname, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { engine } from '@/downloads/engine';
import { colors } from '@/theme/tokens';

type NavItem = { href: Href; match: string; label: string; icon: IconName };

export const NAV_ITEMS: NavItem[] = [
  { href: '/', match: '/', label: 'Home', icon: 'home' },
  { href: '/library', match: '/library', label: 'Library', icon: 'folder' },
  { href: '/search', match: '/search', label: 'Search', icon: 'search' },
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

  if (orientation === 'bottom') {
    return (
      <View className="flex-row border-t border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.match);
          return (
            <Link key={item.match} href={item.href} asChild>
              <Pressable className="flex-1 items-center justify-center py-2">
                <Icon
                  name={item.icon}
                  size={22}
                  color={active ? colors.primary : colors.dark.textMuted}
                />
                <Text
                  className={`mt-1 text-[11px] ${active ? 'text-primary' : 'text-gray-500 dark:text-gray-400'}`}
                >
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
    <View className="w-64 gap-1 border-r border-gray-100 bg-gray-200 px-3 py-4 dark:border-gray-750 dark:bg-gray-800">
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.match);
        return (
          <Link key={item.match} href={item.href} asChild>
            <Pressable
              className={`flex-row items-center gap-3 rounded-lg px-3 py-3 active:bg-gray-50 dark:active:bg-gray-840 ${active ? 'bg-gray-50 dark:bg-gray-840' : ''}`}
            >
              {active ? (
                <View className="absolute bottom-1 left-0 top-1 w-1.5 rounded-r-lg bg-primary" />
              ) : null}
              <Icon name={item.icon} size={20} color={active ? colors.primary : colors.dark.textMuted} />
              <Text
                className={`font-roboto-medium ${active ? 'text-primary' : 'text-gray-600 dark:text-gray-400'}`}
              >
                {item.label}
              </Text>
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}
