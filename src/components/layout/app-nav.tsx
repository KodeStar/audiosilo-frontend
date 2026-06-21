import { Link, usePathname, type Href } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useServerInfo } from '@/api/hooks';
import { RecoveryCodeModal } from '@/components/account/recovery-code-modal';
import { SignOutConfirm } from '@/components/account/sign-out-confirm';
import { useRecoveryCode } from '@/components/account/use-recovery-code';
import { useSignOut } from '@/components/account/use-sign-out';
import { Brand } from '@/components/brand/brand';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { engine } from '@/downloads/engine';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

// `alsoMatch` keeps a tab highlighted on related routes that live outside its
// own path — e.g. a book screen (`/book/...`) is reached through the library.
type NavItem = { href: Href; match: string; label: string; icon: IconName; alsoMatch?: string[] };

// Search lives in the header (phone) / top bar (desktop), not the tab bar.
export const NAV_ITEMS: NavItem[] = [
  { href: '/', match: '/', label: 'Home', icon: 'home' },
  { href: '/library', match: '/library', label: 'Library', icon: 'library', alsoMatch: ['/book'] },
  // Downloads need offline storage: always on native; on web wherever the service
  // worker + Cache API are available (a secure context — https or localhost).
  ...(engine.supported
    ? [{ href: '/downloads', match: '/downloads', label: 'Downloads', icon: 'download' } as NavItem]
    : []),
  { href: '/settings', match: '/settings', label: 'Settings', icon: 'settings' },
];

function matchesPath(pathname: string, match: string) {
  return match === '/' ? pathname === '/' : pathname === match || pathname.startsWith(`${match}/`);
}

function isActive(pathname: string, item: NavItem) {
  return (
    matchesPath(pathname, item.match) ||
    (item.alsoMatch?.some((m) => matchesPath(pathname, m)) ?? false)
  );
}

/** Left sidebar on wide screens, bottom tab bar on phones. */
export function NavBar({ orientation }: { orientation: 'sidebar' | 'bottom' }) {
  const pathname = usePathname();
  const { scheme } = useTheme();
  const { data: server } = useServerInfo();
  // Sign-out is guarded centrally (useSignOut) so the strand-the-user warning
  // can't be skipped here; the recovery hook lets the warning mint + reveal a code
  // in place rather than dead-ending the user on the Settings screen.
  const signOut = useSignOut();
  const recovery = useRecoveryCode();

  if (orientation === 'bottom') {
    return (
      <View className="flex-row border-t border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link key={item.match} href={item.href} asChild>
              <Pressable className="flex-1 items-center justify-center gap-1 py-2.5">
                <Icon
                  name={item.icon}
                  size={24}
                  color={active ? colors.primary : colors.dark.textMuted}
                />
                <Text
                  className={`text-[11px] ${active ? 'text-primary' : 'text-gray-500 dark:text-gray-400'}`}
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
    <View className="w-80 border-r border-gray-100 bg-gray-200 dark:border-gray-750 dark:bg-gray-800 after:content-[''] after:border-r after:absolute after:right-0 after:h-full after:border-gray-300 after:dark:border-gray-860">
      <View className="p-5 border-b border-gray-100 active:bg-gray-50 dark:border-gray-750 dark:active:bg-gray-840 after:content-[''] after:border-b after:absolute after:bottom-0 after:left-0 after:w-full after:border-gray-300 after:dark:border-gray-860">
        <Brand size={50} showVersion version={server?.version} />
      </View>
      <View className="gap-2 p-8 px-6">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item);
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
                  <View className="absolute -left-[1px] -bottom-[1px] top-0 w-1.5 rounded-tl-lg rounded-bl-lg bg-primary" />
                ) : null}
                <Icon name={item.icon} size={24} color={colors[scheme].text} />
                <Text className="text-base text-gray-600 dark:text-gray-300">{item.label}</Text>
              </Pressable>
            </Link>
          );
        })}
      </View>

      <View className="flex-1" />

      <Pressable
        onPress={() => void signOut.requestSignOut()}
        className="flex-row items-center gap-3 border-t border-gray-100 px-6 py-5 active:bg-gray-50 dark:border-gray-750 dark:active:bg-gray-840 after:content-[''] after:border-t after:absolute after:top-[-2px] after:left-0 after:w-full after:border-gray-300 after:dark:border-gray-860"
      >
        <Icon name="logout" size={20} color={colors[scheme].text} />
        <Text className="text-base text-gray-600 dark:text-gray-300">Logout</Text>
      </Pressable>

      <SignOutConfirm
        visible={signOut.confirmVisible}
        onCancel={() => signOut.setConfirmVisible(false)}
        onSignOut={signOut.signOut}
        onSetRecovery={() => {
          signOut.setConfirmVisible(false);
          recovery.requestGenerate();
        }}
      />
      <RecoveryCodeModal code={recovery.code} onClose={() => recovery.setCode(null)} />
    </View>
  );
}
