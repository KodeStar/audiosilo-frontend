import { Fragment, type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useConnectionRemoval } from '@/components/account/connections-section';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon, type IconName } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { isSupportAvailable } from '@/lib/support';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/lib/version';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  parseSettingsSection,
  type SettingsGroup,
  type SettingsPane,
  settingsGroups,
  settingsLayout,
} from './settings-model';
import { SettingsPaneBody } from './settings-panes';

const PANE_ICON: Record<SettingsPane, IconName> = {
  playback: 'play',
  sleep: 'sleep',
  downloads: 'download',
  appearance: 'sun',
  language: 'globe',
  household: 'users',
  accounts: 'server',
  support: 'heart',
};

/** A pane's name (the section nav's item, the pane's heading). */
const paneKey = (pane: SettingsPane) => `settings.sections.${pane}` as const;
const groupKey = (group: SettingsGroup['key']) => `settings.groups.${group}` as const;

/**
 * Settings (STYLEGUIDE section 2, the Stacks prototype's `Settings()`): every app setting,
 * each in exactly one pane, grouped Listening (Playback, Sleep, Up next and downloads), App
 * (Appearance, Language, Household and sharing) and Servers (Accounts and devices,
 * Support), then the version. Laid out by its MEASURED width (`settingsLayout`): from 720
 * a grouped section nav beside one pane's card, the pane named by `section`; narrower,
 * every pane stacked under its group's heading, scrolled to `section` when it names one.
 *
 * Used by the `/settings` route (`section` is its `?section=`, `onSectionChange` writes it
 * back) and by the phone You hub's Settings segment (`embedded`: the hub's large title
 * already says Settings, and its own `section` param is the hub's, so the pane is held
 * here).
 */
export function SettingsContent({
  section,
  onSectionChange,
  embedded = false,
}: {
  /** The pane to show (`/settings?section=`; `preferences`, `accounts` or a pane name). */
  section?: string | string[];
  /** Called when the listener picks another pane in the section nav. */
  onSectionChange?: (pane: SettingsPane) => void;
  /** Inside the You hub: no page heading of its own. */
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const supportOk = isSupportAvailable();
  const groups = settingsGroups(supportOk);
  const asked = parseSettingsSection(section, supportOk);
  const [pane, setPane] = useState(asked);
  // A new `section` (a warm link, the gear with a pane) moves the page there.
  const [lastAsked, setLastAsked] = useState(asked);
  if (asked !== lastAsked) {
    setLastAsked(asked);
    setPane(asked);
  }
  const [width, setWidth] = useState(0);
  const layout = settingsLayout(width, phone);
  const paddingBottom = useMiniPlayerInset();
  // The remove-connection confirm dialog's state lives here (see the hook).
  const removal = useConnectionRemoval();

  const choose = (next: SettingsPane) => {
    setPane(next);
    onSectionChange?.(next);
  };

  const heading = embedded ? null : (
    <Text variant="display" accessibilityRole="header">
      {t('settings.title')}
    </Text>
  );
  const version = (
    <Text variant="caption" className={layout === 'split' ? 'px-3' : 'text-center'}>
      {t('settings.version', { version: APP_VERSION })}
    </Text>
  );

  return (
    <View
      className="flex-1"
      testID="settings-content"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {layout === 'split' ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 p-4 lg:px-8"
          contentContainerStyle={{ paddingBottom }}
        >
          {heading}
          <View className="flex-row items-start gap-8">
            <View className="w-[220px] gap-4">
              <SectionNav groups={groups} pane={pane} onChoose={choose} />
              {version}
            </View>
            <View className="min-w-0 max-w-[760px] flex-1 gap-3.5" testID="settings-pane">
              <Text variant="heading" accessibilityRole="header">
                {t(paneKey(pane))}
              </Text>
              <SettingsPaneBody pane={pane} onRemoveConnection={removal.onRemove} />
            </View>
          </View>
        </ScrollView>
      ) : (
        <StackedPanes
          groups={groups}
          scrollTo={asked}
          heading={heading}
          footer={version}
          paddingBottom={paddingBottom}
          onRemoveConnection={removal.onRemove}
        />
      )}
      {removal.dialog}
    </View>
  );
}

/** The wide page's section nav: the groups' names over their panes, the shown one marked. */
function SectionNav({
  groups,
  pane,
  onChoose,
}: {
  groups: readonly SettingsGroup[];
  pane: SettingsPane;
  onChoose: (pane: SettingsPane) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View
      accessibilityLabel={t('settings.sectionsLabel')}
      role="navigation"
      className="gap-1"
      testID="settings-nav"
    >
      {groups.map((g, i) => (
        <Fragment key={g.key}>
          <Text variant="eyebrow" className={cn('px-3 pb-1', i > 0 && 'mt-3')}>
            {t(groupKey(g.key))}
          </Text>
          {g.panes.map((p) => {
            const current = p === pane;
            return (
              <AnimatedPressable
                key={p}
                testID={`settings-nav-${p}`}
                onPress={() => onChoose(p)}
                accessibilityRole="button"
                accessibilityLabel={t(paneKey(p))}
                accessibilityState={{ selected: current }}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'min-h-[44px] flex-row items-center gap-3 rounded-control border px-3',
                  current ? 'border-border bg-card' : 'border-transparent active:bg-accent',
                  Platform.select({ web: cn(FOCUS_RING_CLASS, !current && 'hover:bg-accent') }),
                )}
              >
                <Icon
                  name={PANE_ICON[p]}
                  size={16}
                  color={current ? themed.foreground : themed.mutedForeground}
                />
                <Text
                  className={cn(
                    'flex-1 text-sm',
                    current ? 'font-sans-semibold text-foreground' : 'text-muted-foreground',
                  )}
                  numberOfLines={1}
                >
                  {t(paneKey(p))}
                </Text>
              </AnimatedPressable>
            );
          })}
        </Fragment>
      ))}
    </View>
  );
}

/** The narrow page: each group's name, then each of its panes titled, one after another;
 * scrolled once to the pane a link named (not the first, which is already in view). */
function StackedPanes({
  groups,
  scrollTo,
  heading,
  footer,
  paddingBottom,
  onRemoveConnection,
}: {
  groups: readonly SettingsGroup[];
  scrollTo: SettingsPane;
  heading: ReactNode;
  footer: ReactNode;
  paddingBottom: number;
  onRemoveConnection: Parameters<typeof SettingsPaneBody>[0]['onRemoveConnection'];
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const ref = useRef<ScrollView>(null);
  // The pane scrolled to last, so a re-layout never pulls the reader back to it.
  const scrolled = useRef<SettingsPane | null>(groups[0]?.panes[0] ?? null);
  const onPaneLayout = (p: SettingsPane, y: number) => {
    if (p !== scrollTo || scrolled.current === p) return;
    scrolled.current = p;
    ref.current?.scrollTo({ y: Math.max(0, y - 8), animated: !reduced });
  };
  return (
    <ScrollView
      ref={ref}
      className="flex-1"
      contentContainerClassName="gap-3 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
      keyboardShouldPersistTaps="handled"
    >
      {heading}
      {groups.map((g) => (
        <Fragment key={g.key}>
          <Text variant="eyebrow" accessibilityRole="header" className="mt-4">
            {t(groupKey(g.key))}
          </Text>
          {g.panes.map((p) => (
            <View
              key={p}
              className="gap-2.5"
              testID={`settings-section-${p}`}
              onLayout={(e) => onPaneLayout(p, e.nativeEvent.layout.y)}
            >
              <Text variant="title" accessibilityRole="header">
                {t(paneKey(p))}
              </Text>
              <SettingsPaneBody pane={p} onRemoveConnection={onRemoveConnection} />
            </View>
          ))}
        </Fragment>
      ))}
      <View className="mt-4">{footer}</View>
    </ScrollView>
  );
}
