import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReachability } from '@/api/reachability';
import { Logo } from '@/components/brand/logo';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Kbd } from '@/components/ui/kbd';
import { Text } from '@/components/ui/text';
import { engine } from '@/downloads/engine';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useSearchStore } from '@/stores/search';
import { useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { TOP_BAR_TABS, useTabPress } from './destinations';
import { shortcutHint } from './palette-model';
import { usePalette } from './palette-store';
import { ProfileMenu } from './profile-menu';

/** Downloads need offline storage: always on native; on web wherever the service worker
 * + Cache API are available (a secure context). Static per page load, so the list never
 * changes under a mounted bar. */
const DESTINATIONS = TOP_BAR_TABS.filter((t) => t.name !== '(offline)' || engine.supported);

/** "Hearthside", "Hearthside + 1 more", or the offline note when the default server is
 * unreachable. Pure, so the top bar's server line is tested without a store. */
export function serverLine(
  connections: readonly { id: string; name: string }[],
  defaultId: string | null,
  online: Record<string, boolean>,
): { kind: 'offline' } | { kind: 'server'; name: string; more: number } | { kind: 'none' } {
  const def = connections.find((c) => c.id === defaultId) ?? connections[0];
  if (!def) return { kind: 'none' };
  if (online[def.id] === false) return { kind: 'offline' };
  return { kind: 'server', name: def.name, more: connections.length - 1 };
}

function ServerLine() {
  const { t } = useTranslation();
  const connections = useSession((s) => s.connections);
  const defaultId = useSession((s) => s.defaultConnectionId);
  const online = useReachability((s) => s.online);
  const line = serverLine(connections, defaultId, online);
  if (line.kind === 'none') return null;
  const offline = line.kind === 'offline';
  const label = offline
    ? t('shell.offline')
    : line.more > 0
      ? t('shell.serverMore', { name: line.name, count: line.more })
      : line.name;
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-warning' : 'bg-success'}`} />
      <Text variant="caption" className="text-[11.5px]" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The tablet/desktop top bar (64, STYLEGUIDE section 2): the mark with the server it
 * talks to, the destinations, the omnisearch, settings and the profile button. Tablet
 * keeps the destinations as icons only.
 *
 * The omnisearch is a field-shaped button: on web it opens the command palette (⌘K);
 * on a native tablet it jumps to the Search tab and focuses its input. The profile
 * button opens the profile menu (servers, account, appearance).
 */
export function TopBar() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const desktop = useLayout() === 'desktop';
  const { active, press } = useTabPress();
  const requestFocus = useSearchStore((s) => s.requestFocus);
  const openPalette = usePalette((s) => s.openPalette);
  const web = Platform.OS === 'web';

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

        <View className="flex-1 flex-row items-center justify-center gap-4">
          <View accessibilityRole="tablist" className="flex-row gap-0.5">
            {DESTINATIONS.map((d) => {
              const selected = active === d.name;
              const label = t(d.labelKey);
              return (
                <AnimatedPressable
                  key={d.name}
                  testID={`top-bar-${d.name}`}
                  onPress={() => press(d.name)}
                  accessibilityRole="tab"
                  aria-selected={selected}
                  accessibilityLabel={label}
                  className={cn(
                    'h-[38px] min-w-[44px] flex-row items-center justify-center gap-2 rounded-control border px-3',
                    selected ? 'border-border bg-card' : 'border-transparent active:bg-accent',
                    Platform.select({ web: !selected && 'hover:bg-accent' }),
                  )}
                >
                  <Icon
                    name={d.icon}
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
            className={cn(
              'h-[38px] min-w-[160px] max-w-[360px] flex-1 flex-row items-center gap-2 rounded-control border border-border bg-card pl-3 pr-2.5',
              Platform.select({ web: 'hover:border-border-strong' }),
            )}
          >
            <Icon name="search" size={16} color={themed.mutedForeground} />
            <Text variant="muted" numberOfLines={1} className="flex-1">
              {t('search.placeholder')}
            </Text>
            {web && desktop ? <Kbd>{shortcutHint(navigatorPlatform())}</Kbd> : null}
          </AnimatedPressable>
        </View>

        <View className="flex-row items-center gap-1.5">
          <AnimatedPressable
            testID="top-bar-settings"
            onPress={() => press('(me)')}
            accessibilityRole="button"
            aria-selected={active === '(me)'}
            accessibilityLabel={t('settings.title')}
            className={cn(
              'h-[38px] w-[38px] items-center justify-center rounded-control border',
              active === '(me)' ? 'border-border bg-card' : 'border-transparent active:bg-accent',
              Platform.select({ web: active !== '(me)' && 'hover:bg-accent' }),
            )}
          >
            <Icon
              name="settings"
              size={19}
              color={active === '(me)' ? themed.foreground : themed.mutedForeground}
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
