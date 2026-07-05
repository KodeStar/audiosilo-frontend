import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text as RNText, View } from 'react-native';

import { ConnectionsSection } from '@/components/account/connections-section';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useLanguage, type LanguagePref } from '@/i18n/language-provider';
import { isSupportAvailable, openSupport } from '@/lib/support';
import { APP_VERSION } from '@/lib/version';
import { useSettings } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: SchemePref[] = ['light', 'dark', 'system'];

const sec = (v: number) => `${v}s`;
const speed = (v: number) => `${Number(v.toFixed(2))}×`;
const mins = (v: number) => `${Math.round(v / 60)}m`;

/** A titled settings group: an eyebrow label above its content, with consistent rhythm. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text variant="label">{title}</Text>
      {children}
    </View>
  );
}

/** A single row inside a quiet stepper card, with a hairline separator above it (all but the first). */
function StepperRow({
  label,
  first,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      className={`flex-row items-center justify-between px-4 py-3.5 ${
        first ? '' : 'border-t border-black/5 dark:border-white/5'
      }`}
    >
      <Text>{label}</Text>
      {children}
    </View>
  );
}

// App-level preferences only. Account management (password, recovery, device
// pairing, sign-out, server version) is per-connection and lives on each
// connection's account screen, reached from the Servers list below.
export default function SettingsScreen() {
  const { t } = useTranslation();
  const { pref, setPref } = useTheme();
  const { pref: langPref, setPref: setLangPref } = useLanguage();

  const appearanceOptions = APPEARANCE.map((value) => ({
    value,
    label: t(`settings.appearance.${value}`),
  }));

  // System default first, then each catalog in its own endonym (not translated).
  const languages: { value: LanguagePref; label: string }[] = [
    { value: 'system', label: t('settings.language.system') },
    ...SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];
  const secOrOff = (v: number) => (v === 0 ? t('settings.playback.off') : `${v}s`);

  const skipForward = useSettings((s) => s.skipForward);
  const skipBackward = useSettings((s) => s.skipBackward);
  const defaultRate = useSettings((s) => s.defaultRate);
  const autoRewindMax = useSettings((s) => s.autoRewindMax);
  const virtualChapterInterval = useSettings((s) => s.virtualChapterInterval);
  const setSkipForward = useSettings((s) => s.setSkipForward);
  const setSkipBackward = useSettings((s) => s.setSkipBackward);
  const setDefaultRate = useSettings((s) => s.setDefaultRate);
  const setAutoRewindMax = useSettings((s) => s.setAutoRewindMax);
  const setVirtualChapterInterval = useSettings((s) => s.setVirtualChapterInterval);

  const paddingBottom = useMiniPlayerInset();

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-6 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <Text variant="heading">{t('settings.title')}</Text>

      <ConnectionsSection />

      <Section title={t('settings.appearance.label')}>
        <SegmentedControl options={appearanceOptions} value={pref} onChange={setPref} grow />
      </Section>

      <Section title={t('settings.language.label')}>
        {/* A long, wrapping list, so it stays a pill group rather than a single-row
            segmented control - but the pills share the SegmentedControl idiom (a quiet
            track with the active option filled in primary). */}
        <View className="flex-row flex-wrap gap-2 rounded-lg bg-gray-100 p-1 dark:bg-gray-840">
          {languages.map((o) => {
            const active = langPref === o.value;
            return (
              <AnimatedPressable
                key={o.value}
                onPress={() => setLangPref(o.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={o.label}
                className={`items-center rounded-md px-3 py-1.5 ${active ? 'bg-primary' : ''}`}
              >
                {/* Raw RN Text with the full explicit class string: the themed
                    <Text> body variant injects its own text-color class, which
                    NativeWind's class merge doesn't override last-wins with an
                    appended text-white, so the active label rendered gray-on-pink
                    (matches SegmentedControl's approach). */}
                <RNText
                  className={`font-roboto-medium text-sm ${
                    active ? 'text-white' : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {o.label}
                </RNText>
              </AnimatedPressable>
            );
          })}
        </View>
      </Section>

      <Section title={t('settings.playback.label')}>
        <View className="overflow-hidden rounded-lg bg-white shadow-sm dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none">
          <StepperRow label={t('settings.playback.skipBack')} first>
            <Stepper
              value={skipBackward}
              onChange={setSkipBackward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </StepperRow>
          <StepperRow label={t('settings.playback.skipForward')}>
            <Stepper
              value={skipForward}
              onChange={setSkipForward}
              step={5}
              min={5}
              max={120}
              format={sec}
            />
          </StepperRow>
          <StepperRow label={t('settings.playback.defaultSpeed')}>
            <Stepper
              value={defaultRate}
              onChange={setDefaultRate}
              step={0.05}
              min={0.5}
              max={2}
              format={speed}
            />
          </StepperRow>
          <StepperRow label={t('settings.playback.autoRewind')}>
            <Stepper
              value={autoRewindMax}
              onChange={setAutoRewindMax}
              step={5}
              min={0}
              max={30}
              format={secOrOff}
            />
          </StepperRow>
          <StepperRow label={t('settings.playback.chapterLength')}>
            <Stepper
              value={virtualChapterInterval}
              onChange={setVirtualChapterInterval}
              step={300}
              min={300}
              max={3600}
              format={mins}
            />
          </StepperRow>
        </View>
      </Section>

      {/* Support is web/Android only - Apple disallows linking out to an external
          developer-donation page, and the UK App Store is outside the US/EU
          carve-outs that now permit it (see src/lib/support.ts). */}
      {isSupportAvailable() ? (
        <Section title={t('settings.support.label')}>
          <Card className="gap-3">
            <Text variant="muted">{t('settings.support.intro')}</Text>
            <Button
              title={t('settings.support.cta')}
              icon="heart"
              variant="secondary"
              onPress={() => void openSupport()}
            />
          </Card>
        </Section>
      ) : null}

      <Text variant="caption" className="text-center">
        {t('settings.version', { version: APP_VERSION })}
      </Text>
    </ScrollView>
  );
}
