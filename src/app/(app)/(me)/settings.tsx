import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { ConnectionsSection, useConnectionRemoval } from '@/components/account/connections-section';
import {
  KeepAheadControl,
  KeepAheadStatusLine,
  useAutoDownloadModes,
} from '@/components/downloads/rules-card';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type SelectOption,
} from '@/components/ui/select';
import { Stepper } from '@/components/ui/stepper';
import { Text } from '@/components/ui/text';
import { TimeStepper } from '@/components/ui/time-stepper';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/toggle-group';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { useLanguage, type LanguagePref } from '@/i18n/language-provider';
import { formatSpeed } from '@/lib/format';
import { isSupportAvailable, openSupport } from '@/lib/support';
import { APP_VERSION } from '@/lib/version';
import { useSettings, type AutoSleepType } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

const APPEARANCE: SchemePref[] = ['light', 'dark', 'system'];

const sec = (v: number) => `${v}s`;
const mins = (v: number) => `${Math.round(v / 60)}m`;

/** A titled settings group: an eyebrow label above its content, with consistent rhythm. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text variant="eyebrow">{title}</Text>
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
        first ? '' : 'border-t border-border'
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
  // the timer type is a Select.
  const sleepTypeOptions: (SelectOption & { value: AutoSleepType })[] = [
    { value: 'chapter', label: t('settings.sleep.type.chapter') },
    // The player's own timer menu already owns a pluralised "N min" string; reusing
    // it keeps the two lists worded identically and plural-correct in every locale.
    ...(['15', '30', '45', '60'] as const).map((value) => ({
      value,
      label: t('player.sleepTimer.minutes', { count: Number(value) }),
    })),
  ];
  const sleepTypeOption =
    sleepTypeOptions.find((o) => o.value === autoSleepType) ?? sleepTypeOptions[0];

  const onOff: SegmentedOption<'on' | 'off'>[] = [
    { value: 'on', label: t('common.on') },
    { value: 'off', label: t('common.off') },
  ];
  const downloadOptions = useAutoDownloadModes();

  const paddingBottom = useMiniPlayerInset();

  // The remove-connection confirm dialog's state lives in this screen (see the hook).
  const connectionRemoval = useConnectionRemoval();

  return (
    <>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 p-4 lg:px-8"
        contentContainerStyle={{ paddingBottom }}
      >
        <ConnectionsSection onRemove={connectionRemoval.onRemove} />

        <Section title={t('settings.appearance.label')}>
          <SegmentedControl
            options={appearanceOptions}
            value={pref}
            onChange={setPref}
            grow
            accessibilityLabel={t('settings.appearance.label')}
          />
        </Section>

        <Section title={t('settings.language.label')}>
          {/* A long list, so the segments wrap onto more lines instead of one row. */}
          <SegmentedControl
            options={languages}
            value={langPref}
            onChange={setLangPref}
            wrap
            accessibilityLabel={t('settings.language.label')}
            className="self-start"
          />
        </Section>

        <Section title={t('settings.playback.label')}>
          <Card className="overflow-hidden p-0">
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
                format={formatSpeed}
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
          </Card>
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
                accessibilityLabel={t('settings.sleep.auto.label')}
              />
            </ChoiceRow>
            {/* The window and the timer's kind only matter once the feature is on. */}
            {autoSleepTimer ? (
              <View className="gap-2">
                <Card className="overflow-hidden p-0">
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
                  <StepperRow label={t('settings.sleep.type.label')}>
                    <Select
                      value={sleepTypeOption}
                      onValueChange={(o) => {
                        if (o) setAutoSleepType(o.value as AutoSleepType);
                      }}
                    >
                      <SelectTrigger
                        className="min-w-[150px] shrink"
                        accessibilityLabel={t('settings.sleep.type.label')}
                      >
                        <SelectValue placeholder={sleepTypeOption.label} />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {sleepTypeOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value} label={o.label} />
                        ))}
                      </SelectContent>
                    </Select>
                  </StepperRow>
                </Card>
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
                accessibilityLabel={t('settings.upNext.autoPlay.label')}
              />
            </ChoiceRow>
            {/* The same setting, and words, as the Downloads page's rules card. */}
            <ChoiceRow
              label={t('downloads.rules.mode.label')}
              description={t('downloads.rules.modeHint')}
            >
              <SegmentedControl
                options={downloadOptions}
                value={autoDownloadNext}
                onChange={setAutoDownloadNext}
                grow
                accessibilityLabel={t('downloads.rules.mode.label')}
              />
            </ChoiceRow>
            {/* The same setting as the Downloads page's "Automatic downloads" card. */}
            <ChoiceRow
              label={t('downloads.rules.keepAhead.label')}
              description={t('downloads.rules.keepAhead.hint')}
            >
              <KeepAheadControl grow />
              <KeepAheadStatusLine />
            </ChoiceRow>
            {/* The same setting, and words, as the Downloads page's rules card. */}
            <ChoiceRow
              label={t('downloads.rules.autoDelete')}
              description={t('settings.upNext.autoDelete.description')}
            >
              <SegmentedControl
                options={onOff}
                value={autoDeleteFinished ? 'on' : 'off'}
                onChange={(v) => setAutoDeleteFinished(v === 'on')}
                grow
                accessibilityLabel={t('downloads.rules.autoDelete')}
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
      {connectionRemoval.dialog}
    </>
  );
}
