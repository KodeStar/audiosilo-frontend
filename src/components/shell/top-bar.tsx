import { usePathname } from 'expo-router';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { firstOffline, serverStatus, useReachability } from '@/api/reachability';
import { Logo } from '@/components/brand/logo';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { Text } from '@/components/ui/text';
import { UpNextButton } from '@/components/upnext/up-next-button';
import { useDeviceOnline } from '@/lib/device-online';
import { useLayout } from '@/lib/layout';
import { openSettings } from '@/lib/open';
import { cn } from '@/lib/utils';
import { useSearchStore } from '@/stores/search';
import { useProfileConnections } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { TOP_BAR_TABS, useTabPress, wideIcon, wideLabelKey } from './destinations';
import { shortcutHint } from './palette-model';
import { usePalette } from './palette-store';
import { ProfileMenu } from './profile-menu';

/** "Hearthside", "Hearthside + 1 more", the default server's trouble (`serverStatus`:
 * it needs signing in again, or it is unreachable, with its name), or the name of another server that
 * is not answering (`down`: never a green "+ 1 more" over a server that is down;
 * frontend#131). Pure, so the top bar's server line is tested without a store. */
export function serverLine(
  connections: readonly Pick<Connection, 'id' | 'name' | 'needsReconnect'>[],
  defaultId: string | null,
  online: Record<string, boolean>,
):
  | { kind: 'offline'; name: string }
  | { kind: 'reconnect' }
  | { kind: 'server'; name: string; more: number }
  | { kind: 'down'; name: string }
  | { kind: 'none' } {
  const def = connections.find((c) => c.id === defaultId) ?? connections[0];
  if (!def) return { kind: 'none' };
  const status = serverStatus(def, online);
  if (status === 'offline') return { kind: 'offline', name: def.name };
  if (status === 'reconnect') return { kind: 'reconnect' };
  const down = firstOffline(connections, online);
  if (down) return { kind: 'down', name: down.name };
  return { kind: 'server', name: def.name, more: connections.length - 1 };
}

/** The server line in words. With a network on the device, a default server that is down
 * is named ("Hearthside isn't answering"); without one, the device is offline
 * (CONNECT-15). */
export function serverLineLabel(
  line: Exclude<ReturnType<typeof serverLine>, { kind: 'none' }>,
  deviceOnline: boolean,
  t: TFunction,
): string {
  switch (line.kind) {
    case 'offline':
      return deviceOnline ? t('shell.notAnswering', { name: line.name }) : t('shell.offline');
    case 'reconnect':
      return t('shell.profile.reconnect');
    case 'down':
      return t('shell.notAnswering', { name: line.name });
    case 'server':
      return line.more > 0
        ? t('shell.serverMore', { name: line.name, count: line.more })
        : line.name;
  }
}

function ServerLine() {
  const { t } = useTranslation();
  // The servers of the person listening (Phase 8 profiles).
  const connections = useProfileConnections();
  const defaultId = useSession((s) => s.defaultConnectionId);
  const online = useReachability((s) => s.online);
  const deviceOnline = useDeviceOnline();
  const line = serverLine(connections, defaultId, online);
  if (line.kind === 'none') return null;
  const label = serverLineLabel(line, deviceOnline, t);
  return (
    <View className="flex-row items-center gap-1.5">
      <View
        className={`h-1.5 w-1.5 rounded-full ${line.kind === 'server' ? 'bg-success' : 'bg-warning'}`}
      />
      <Text variant="caption" className="text-[11.5px]" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The narrowest the omnisearch field reads as a field ("Search books, ..." and its
 * glyph); below it the top bar shows a search icon button instead. */
export const OMNISEARCH_MIN = 180;
const MIDDLE_GAP = 16;

/**
 * Whether the omnisearch field fits beside the destinations in the top bar's middle
 * (`middle` wide, the destinations `tabs` wide). Unknown widths (0, before the first
 * layout) count as fitting, so a wide desktop never starts collapsed.
 */
export function omnisearchFits(middle: number, tabs: number): boolean {
  if (middle <= 0) return true;
  return middle - tabs - MIDDLE_GAP >= OMNISEARCH_MIN;
}

/** A top bar destination or icon button: a quiet card when selected, else a hover fill. */
function topBarItemClass(selected: boolean): string {
  return cn(
    'h-[38px] items-center justify-center rounded-control border',
    selected ? 'border-border bg-card' : 'border-transparent active:bg-accent',
    Platform.select({ web: !selected && 'hover:bg-accent' }),
  );
}

/**
 * The tablet/desktop top bar (64, STYLEGUIDE section 2): the mark with the server it
 * talks to, the destinations (Home, Library, Downloads, You), the omnisearch, Up next
 * (with its count), the Settings gear (a page pushed on the current tab, `openSettings`)
 * and the profile button. Tablet keeps the destinations as icons only.
 *
 * The omnisearch is a field-shaped button: on web it opens the command palette (⌘K);
 * on a native tablet it jumps to the Search tab and focuses its input. Where the middle
 * of the bar is too narrow for the field (a narrow tablet, a long server line), it is a
 * search icon button doing the same (`omnisearchFits`), so it never runs under the
 * buttons on the right. The profile button opens the profile menu (servers, account,
 * appearance).
 */
export function TopBar() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const desktop = useLayout() === 'desktop';
  const { active, press } = useTabPress();
  const onSettings = usePathname() === '/settings';
  const requestFocus = useSearchStore((s) => s.requestFocus);
  const openPalette = usePalette((s) => s.openPalette);
  const web = Platform.OS === 'web';
  // The middle's width (flex-1, so set by the mark and the right-hand buttons, never by
  // the search) and the destinations' width decide field or icon.
  const [middle, setMiddle] = useState(0);
  const [tabs, setTabs] = useState(0);
  const field = omnisearchFits(middle, tabs);

  const openSearch = () => {
    if (web) return openPalette();
    requestFocus();
    press('(search)');
  };

  return (
    <View
      testID="shell-top-bar"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
      className="border-b border-border bg-background"
    >
      <View className="h-[64px] flex-row items-center gap-4 px-4 lg:gap-5 lg:px-6">
        <AnimatedPressable
          onPress={() => press('(home)')}
          accessibilityRole="button"
          accessibilityLabel={t('shell.home')}
          className="flex-row items-center gap-2.5 rounded-control py-1.5 pl-1 pr-2 active:bg-accent"
        >
          <View className="h-[30px] w-[30px] items-center justify-center rounded-control bg-primary">
            <Logo size={16} />
          </View>
          <View className="gap-0.5">
            {/* eslint-disable-next-line i18next/no-literal-string -- the product name */}
            <Text className="font-display text-base leading-[18px]">AudioSilo</Text>
            <ServerLine />
          </View>
        </AnimatedPressable>

        <View
          className="min-w-0 flex-1 flex-row items-center justify-center gap-4"
          onLayout={(e) => setMiddle(e.nativeEvent.layout.width)}
        >
          <View
            accessibilityRole="tablist"
            className="flex-row gap-0.5"
            onLayout={(e) => setTabs(e.nativeEvent.layout.width)}
          >
            {TOP_BAR_TABS.map((d) => {
              const selected = active === d.name;
              const label = t(wideLabelKey(d));
              return (
                <AnimatedPressable
                  key={d.name}
                  testID={`top-bar-${d.name}`}
                  onPress={() => press(d.name)}
                  accessibilityRole="tab"
                  aria-selected={selected}
                  accessibilityLabel={label}
                  className={cn(topBarItemClass(selected), 'min-w-[44px] flex-row gap-2 px-3')}
                >
                  <Icon
                    name={wideIcon(d)}
                    size={18}
                    color={selected ? themed.brand : themed.mutedForeground}
                  />
                  {desktop ? (
                    <Text
                      className={`font-sans-semibold text-sm ${
                        selected ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {label}
                    </Text>
                  ) : null}
                </AnimatedPressable>
              );
            })}
          </View>

          <AnimatedPressable
            testID="top-bar-search"
            onPress={openSearch}
            accessibilityRole="button"
            accessibilityLabel={web ? t('palette.omnisearch') : t('nav.search')}
            className={
              field
                ? cn(
                    'h-[38px] min-w-0 max-w-[360px] flex-1 flex-row items-center gap-2 rounded-control border border-border bg-card pl-3 pr-2.5',
                    Platform.select({ web: 'hover:border-border-strong' }),
                  )
                : cn(topBarItemClass(false), 'w-[38px]')
            }
          >
            <Icon name="search" size={field ? 16 : 18} color={themed.mutedForeground} />
            {field ? (
              <Text variant="muted" numberOfLines={1} className="flex-1">
                {t('search.placeholder')}
              </Text>
            ) : null}
            {field && web && desktop ? <Kbd>{shortcutHint(navigatorPlatform())}</Kbd> : null}
          </AnimatedPressable>
        </View>

        <View className="flex-row items-center gap-1.5">
          <UpNextButton variant="bar" />
          <AnimatedPressable
            testID="top-bar-settings"
            onPress={() => openSettings()}
            accessibilityRole="button"
            // A button outside the tablist: it marks the current page, not a selected tab
            // (web only; native has no aria-current).
            aria-current={onSettings ? 'page' : undefined}
            accessibilityLabel={t('settings.title')}
            className={cn(topBarItemClass(onSettings), 'w-[38px]')}
          >
            <Icon
              name="settings"
              size={19}
              color={onSettings ? themed.foreground : themed.mutedForeground}
            />
          </AnimatedPressable>
          <ProfileMenu showName={desktop} />
        </View>
      </View>
    </View>
  );
}

/** The browser's platform string, for the key hint ('' off the web). */
function navigatorPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? '';
}
