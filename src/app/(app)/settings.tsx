import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text as RNText, View } from 'react-native';

import { ConnectionsSection, useConnectionRemoval } from '@/components/account/connections-section';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control';
import { SelectRow, SelectSheet, type SelectOption } from '@/components/ui/select-row';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { TimeStepper } from '@/components/ui/time-stepper';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useLanguage, type LanguagePref } from '@/i18n/language-provider';
import { isSupportAvailable, openSupport } from '@/lib/support';
import { APP_VERSION } from '@/lib/version';
import { useSettings, type AutoDownloadMode, type AutoSleepType } from '@/stores/settings';
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

/** A choice setting: a label, a one-line description, and its control stacked below -
 * the layout the segmented controls (wider than a compact stepper) read best in. */
function ChoiceRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="gap-0.5">
        <Text>{label}</Text>
        <Text variant="caption">{description}</Text>
      </View>
      {children}
    </View>
  );
}

// App-level preferences only. Account management (password, device pairing,
// sign-out, server version) is per-connection and lives on each
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

  const autoPlayNext = useSettings((s) => s.autoPlayNext);
  const autoDownloadNext = useSettings((s) => s.autoDownloadNext);
  const autoDeleteFinished = useSettings((s) => s.autoDeleteFinished);
  const setAutoPlayNext = useSettings((s) => s.setAutoPlayNext);
  const setAutoDownloadNext = useSettings((s) => s.setAutoDownloadNext);
  const setAutoDeleteFinished = useSettings((s) => s.setAutoDeleteFinished);

  const autoSleepTimer = useSettings((s) => s.autoSleepTimer);
  const autoSleepFrom = useSettings((s) => s.autoSleepFrom);
  const autoSleepUntil = useSettings((s) => s.autoSleepUntil);
  const autoSleepType = useSettings((s) => s.autoSleepType);
  const setAutoSleepTimer = useSettings((s) => s.setAutoSleepTimer);
  const setAutoSleepFrom = useSettings((s) => s.setAutoSleepFrom);
  const setAutoSleepUntil = useSettings((s) => s.setAutoSleepUntil);
  const setAutoSleepType = useSettings((s) => s.setAutoSleepType);
  // Five options is too many to stay readable in a SegmentedControl on a phone, so
  // the timer type is a select row + bottom sheet (mounted at screen level below).
  const [sleepTypeOpen, setSleepTypeOpen] = useState(false);
  const sleepTypeOptions: SelectOption<AutoSleepType>[] = [
    { value: 'chapter', label: t('settings.sleep.type.chapter') },
    // The player's own timer menu already owns a pluralised "N min" string; reusing
    // it keeps the two lists worded identically and plural-correct in every locale.
    ...(['15', '30', '45', '60'] as const).map((value) => ({
      value,
      label: t('player.sleepTimer.minutes', { count: Number(value) }),
    })),
  ];
  const sleepTypeLabel =
    sleepTypeOptions.find((o) => o.value === autoSleepType)?.label ?? sleepTypeOptions[0].label;

  const onOff: SegmentedOption<'on' | 'off'>[] = [
    { value: 'on', label: t('common.on') },
    { value: 'off', label: t('common.off') },
  ];
  const downloadOptions: SegmentedOption<AutoDownloadMode>[] = [
    { value: 'never', label: t('settings.upNext.autoDownload.never') },
    { value: 'wifi', label: t('settings.upNext.autoDownload.wifi') },
    { value: 'always', label: t('settings.upNext.autoDownload.always') },
  ];

  const paddingBottom = useMiniPlayerInset();

  // The remove-connection confirm dialog is rendered at screen level (below, outside
  // the ScrollView): a ModalCard/OverlayHost renders in place and must not be mounted
  // inside a scroll container.
  const connectionRemoval = useConnectionRemoval();

  return (
    <>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 p-4 lg:px-8"
        contentContainerStyle={{ paddingBottom }}
      >
        <Text variant="heading">{t('settings.title')}</Text>

        <ConnectionsSection onRemove={connectionRemoval.onRemove} />

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
          <View className="overflow-hidden rounded-lg bg-white shadow-xs ios-clipped-shadow dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none">
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

        <Section title={t('settings.sleep.label')}>
          <View className="gap-5">
            <ChoiceRow
              label={t('settings.sleep.auto.label')}
              description={t('settings.sleep.auto.description')}
            >
              <SegmentedControl
                options={onOff}
                value={autoSleepTimer ? 'on' : 'off'}
                onChange={(v) => setAutoSleepTimer(v === 'on')}
                grow
              />
            </ChoiceRow>
            {/* The window and the timer's kind only matter once the feature is on. */}
            {autoSleepTimer ? (
              <View className="gap-2">
                <View className="overflow-hidden rounded-lg bg-white shadow-xs ios-clipped-shadow dark:border dark:border-gray-860 dark:bg-gray-840 dark:shadow-none">
                  <StepperRow label={t('settings.sleep.from')} first>
                    <TimeStepper
                      value={autoSleepFrom}
                      onChange={setAutoSleepFrom}
                      label={t('settings.sleep.from')}
                    />
                  </StepperRow>
                  <StepperRow label={t('settings.sleep.until')}>
                    <TimeStepper
                      value={autoSleepUntil}
                      onChange={setAutoSleepUntil}
                      label={t('settings.sleep.until')}
                    />
                  </StepperRow>
                  <SelectRow
                    label={t('settings.sleep.type.label')}
                    value={sleepTypeLabel}
                    onPress={() => setSleepTypeOpen(true)}
                  />
                </View>
                {/* Both bounds on the same time is a zero-length window, which
                  `withinAutoSleepWindow` reads as NEVER - and the stepper wraps in 30
                  minute steps, so walking "Until" back onto "From" takes one tap. Without
                  this the screen shows a feature that is switched on and can never arm,
                  with nothing to explain why. */}
                {autoSleepFrom === autoSleepUntil ? (
                  <Text variant="caption">{t('settings.sleep.sameTimes')}</Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </Section>

        <Section title={t('settings.upNext.label')}>
          <View className="gap-5">
            <ChoiceRow
              label={t('settings.upNext.autoPlay.label')}
              description={t('settings.upNext.autoPlay.description')}
            >
              <SegmentedControl
                options={onOff}
                value={autoPlayNext ? 'on' : 'off'}
                onChange={(v) => setAutoPlayNext(v === 'on')}
                grow
              />
            </ChoiceRow>
            <ChoiceRow
              label={t('settings.upNext.autoDownload.label')}
              description={t('settings.upNext.autoDownload.description')}
            >
              <SegmentedControl
                options={downloadOptions}
                value={autoDownloadNext}
                onChange={setAutoDownloadNext}
                grow
              />
            </ChoiceRow>
            <ChoiceRow
              label={t('settings.upNext.autoDelete.label')}
              description={t('settings.upNext.autoDelete.description')}
            >
              <SegmentedControl
                options={onOff}
                value={autoDeleteFinished ? 'on' : 'off'}
                onChange={(v) => setAutoDeleteFinished(v === 'on')}
                grow
              />
            </ChoiceRow>
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
      {/* Mounted at screen level, outside the ScrollView: a Sheet renders in place and
        would be clipped inside a scroll container (same reason as the dialog below). */}
      <SelectSheet
        visible={sleepTypeOpen}
        title={t('settings.sleep.type.label')}
        options={sleepTypeOptions}
        value={autoSleepType}
        onChange={setAutoSleepType}
        onClose={() => setSleepTypeOpen(false)}
      />
      {connectionRemoval.dialog}
    </>
  );
}
