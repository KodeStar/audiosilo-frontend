import { Link, usePathname, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text as RNText, View } from 'react-native';

import { Brand } from '@/components/brand/brand';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon, type IconName } from '@/components/ui/icon';
import { engine } from '@/downloads/engine';
import { isActiveNav } from '@/lib/nav';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

// `alsoMatch` keeps a tab highlighted on related routes that live outside its
// own path - e.g. a book screen (`/book/...`) is reached through the library.
// `labelKey` is the i18n key suffix under `nav.` - resolved with `t()` at render
// since this is a module-level static array (no hook in scope here).
type NavItem = {
  href: Href;
  match: string;
  labelKey: 'home' | 'library' | 'downloads' | 'settings';
  icon: IconName;
  alsoMatch?: string[];
};

// Search lives in the header (phone) / top bar (desktop), not the tab bar.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', match: '/', labelKey: 'home', icon: 'home' },
  {
    href: '/library',
    match: '/library',
    labelKey: 'library',
    icon: 'library',
    alsoMatch: ['/book'],
  },
  // Downloads need offline storage: always on native; on web wherever the service
  // worker + Cache API are available (a secure context - https or localhost).
  ...(engine.supported
    ? [
        {
          href: '/downloads',
          match: '/downloads',
          labelKey: 'downloads',
          icon: 'download',
        } as NavItem,
      ]
    : []),
  { href: '/settings', match: '/settings', labelKey: 'settings', icon: 'settings' },
];

/** Left sidebar on wide screens, bottom tab bar on phones. */
export function NavBar({ orientation }: { orientation: 'sidebar' | 'bottom' }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const { scheme } = useTheme();

  if (orientation === 'bottom') {
    return (
      <View className="flex-row border-t border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800">
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item);
          const label = t(`nav.${item.labelKey}`);
          return (
            <Link key={item.match} href={item.href} asChild>
              <AnimatedPressable
                className="relative flex-1 items-center justify-center gap-1 py-2.5"
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
              >
                {/* Primary indicator bar centered above the icon on the active tab.
                    Absolutely positioned so it never changes the measured nav height. */}
                {active ? (
                  <View className="absolute inset-x-0 top-1 items-center">
                    <View className="h-1 w-4 rounded-full bg-primary" />
                  </View>
                ) : null}
                <Icon
                  name={item.icon}
                  size={24}
                  color={active ? colors.primary : colors[scheme].textMuted}
                />
                <RNText
                  className={`text-[11px] ${
                    active ? 'font-roboto-medium text-primary' : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {label}
                </RNText>
              </AnimatedPressable>
            </Link>
          );
        })}
      </View>
    );
  }

  return (
    <View className="w-80 border-r border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800">
      <View className="px-6 py-7">
        {/* App build version, not a server's - account/server details are per-connection
            on each connection's account screen (reached from Settings → Servers). */}
        <Brand size={50} showVersion />
      </View>
      <View className="gap-1 px-4">
        {NAV_ITEMS.map((item) => {
          const active = isActiveNav(pathname, item);
          const label = t(`nav.${item.labelKey}`);
          return (
            <Link key={item.match} href={item.href} asChild>
              <AnimatedPressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={label}
                className={`relative flex-row items-center gap-3 rounded-xl px-3 py-2.5 ${
                  active
                    ? 'bg-white shadow-sm dark:bg-gray-750 dark:shadow-none'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-840'
                }`}
              >
                {/* 3px rounded primary accent hugging the pill's left inside edge. */}
                {active ? (
                  <View className="absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-primary" />
                ) : null}
                <Icon
                  name={item.icon}
                  size={22}
                  color={active ? colors.primary : colors[scheme].textMuted}
                />
                <RNText
                  className={`text-base ${
                    active
                      ? 'font-roboto-semibold text-primary'
                      : 'font-roboto-regular text-gray-600 dark:text-gray-300'
                  }`}
                >
                  {label}
                </RNText>
              </AnimatedPressable>
            </Link>
          );
        })}
      </View>

      <View className="flex-1" />
    </View>
  );
}
