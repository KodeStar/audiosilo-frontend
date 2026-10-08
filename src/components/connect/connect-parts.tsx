import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import type { KnownServer } from '@/lib/known-servers';
import { clothColor } from '@/lib/monogram';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

import { hostOf } from './connect-model';

/** What the first step learned about the address it was given. */
export type Probe =
  | { kind: 'found'; base: string; name: string; version: string; demo: boolean }
  | { kind: 'unreachable'; address: string; home: boolean }
  | { kind: 'error'; message: string };

/**
 * The first step's answer under the address field (STYLEGUIDE section 8, "Notice"):
 * "Found Hearthside, AudioSilo 1.17.0" with Sign in (and Try the demo when the server
 * offers one), or what went wrong with the honest fix. Announced to screen readers.
 */
export function ProbeNotice({
  probe,
  onSignIn,
  onDemo,
  demoLoading,
}: {
  probe: Probe;
  onSignIn: () => void;
  onDemo: () => void;
  demoLoading: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const found = probe.kind === 'found';
  const tone = found ? 'success' : 'warning';
  const icon: IconName = found ? 'circle-check' : 'circle-exclamation';
  const title =
    probe.kind === 'found'
      ? t('connect.probe.found', { name: probe.name })
      : probe.kind === 'unreachable'
        ? t('connect.probe.unreachable', { address: probe.address })
        : t('connect.probe.errorTitle');
  const body =
    probe.kind === 'found'
      ? t('connect.probe.version', { version: probe.version })
      : probe.kind === 'unreachable'
        ? probe.home
          ? t('connect.probe.homeHint')
          : t('connect.probe.hint')
        : t('connect.probe.errorBody', { message: probe.message });
  return (
    <Card
      testID="probe-notice"
      accessibilityLiveRegion="polite"
      role={found ? 'status' : 'alert'}
      className="gap-3 p-4"
    >
      <View className="flex-row items-start gap-3.5">
        <View
          className={cn(
            'h-9 w-9 items-center justify-center rounded-[11px]',
            found ? 'bg-success-soft' : 'bg-warning-soft',
          )}
        >
          <Icon name={icon} size={17} color={themed[tone]} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="label">{title}</Text>
          <Text variant="muted">{body}</Text>
        </View>
      </View>
      {probe.kind === 'found' ? (
        <View className="flex-row flex-wrap justify-end gap-2">
          {probe.demo ? (
            <Button
              variant="outline"
              icon="sparkles"
              title={t('connect.server.tryDemo')}
              loading={demoLoading}
              onPress={onDemo}
            />
          ) : null}
          <Button
            title={t('connect.probe.signIn')}
            accessibilityLabel={t('connect.probe.signInTo', { name: probe.name })}
            onPress={onSignIn}
          />
        </View>
      ) : null}
    </Card>
  );
}

/** A remembered server as a one-tap "Reconnect to <name>" row, with its forget button. */
export function KnownServerRow({
  entry,
  busy,
  disabled,
  onReconnect,
  onForget,
}: {
  entry: KnownServer;
  busy: boolean;
  disabled: boolean;
  onReconnect: () => void;
  onForget: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View className="flex-row items-center gap-2">
      <PressableRow
        accessibilityRole="button"
        accessibilityLabel={t('reconnect.connect.action', { name: entry.name })}
        accessibilityHint={hostOf(entry.serverUrl)}
        aria-busy={busy || undefined}
        disabled={disabled}
        onPress={onReconnect}
        className={cn('min-h-[56px] flex-1 flex-row items-center gap-3 px-3.5 py-3')}
      >
        <ServerMark name={entry.name} />
        <View className="min-w-0 flex-1">
          <Text variant="label" numberOfLines={1}>
            {t('reconnect.connect.action', { name: entry.name })}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {hostOf(entry.serverUrl)}
          </Text>
        </View>
        {busy ? (
          <Spinner color={themed.mutedForeground} />
        ) : (
          <Icon name="chevron-right" size={16} color={themed.mutedForeground} />
        )}
      </PressableRow>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('reconnect.connect.forget', { name: entry.name })}
        onPress={onForget}
        className={cn(
          'h-11 w-11 items-center justify-center rounded-lg active:bg-accent',
          Platform.select({ web: `hover:bg-accent ${FOCUS_RING_CLASS}` }),
        )}
      >
        <Icon name="close" size={16} color={themed.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** A server's mark: the logo in white on a cloth colour of its own. */
function ServerMark({ name }: { name: string }) {
  return (
    <View
      style={{ backgroundColor: clothColor(name) }}
      className="h-10 w-10 items-center justify-center rounded-[11px]"
    >
      <Logo size={18} color={colors.white} />
    </View>
  );
}

/** "Another server": back to the first step. */
export function BackToStart({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <Button variant="ghost" onPress={onPress} className="self-start">
      <Icon name="arrow-left" size={16} color={themed.foreground} />
      <Text>{t('onboarding.anotherServer')}</Text>
    </Button>
  );
}
