import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ConnectionsSection } from '@/components/account/connections-section';
import {
  KeepAheadControl,
  KeepAheadStatusLine,
  useAutoDownloadModes,
} from '@/components/downloads/rules-card';
import { EffectsSettings } from '@/components/player/effects-settings';
import { ShakeSensitivityControl } from '@/components/player/sleep-timer-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
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
import { openSupport } from '@/lib/support';
import { shakeAvailable } from '@/playback/use-shake-to-extend';
import type { Connection } from '@/stores/session';
import { useSettings, type AutoSleepType } from '@/stores/settings';
import { useTheme, type SchemePref } from '@/theme/theme-provider';

import type { SettingsPane } from './settings-model';
import { SettingRow, SettingsCard } from './settings-row';

/**
 * The bodies of the Settings panes (`settings-model.ts` names and groups them). Every
 * control and store key is the one the app has always used: the regroup moved them, it
 * did not change them. Each setting is here once; the Downloads page and the series page
 * bind the same values as shortcuts (`rules-card.tsx`).
 */

const APPEARANCE: SchemePref[] = ['light', 'dark', 'system'];

const sec = (v: number) => `${v}s`;
const mins = (v: number) => `${Math.round(v / 60)}m`;

function useOnOff(): SegmentedOption<'on' | 'off'>[] {
  const { t } = useTranslation();
  return [
    { value: 'on', label: t('common.on') },
    { value: 'off', label: t('common.off') },
  ];
}

/** An on/off setting as the app has always shown it: a two-way segmented control. */
function OnOff({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  const options = useOnOff();
  return (
    <SegmentedControl
      options={options}
      value={value ? 'on' : 'off'}
      onChange={(v) => onChange(v === 'on')}
      grow
      accessibilityLabel={label}
    />
  );
}

function PlaybackPane() {
  const { t } = useTranslation();
  const s = useSettings();
  const secOrOff = (v: number) => (v === 0 ? t('settings.playback.off') : `${v}s`);
  const rows = [
    {
      label: t('settings.playback.skipBack'),
      value: s.skipBackward,
      onChange: s.setSkipBackward,
      step: 5,
      min: 5,
      max: 120,
      format: sec,
    },
    {
      label: t('settings.playback.skipForward'),
      value: s.skipForward,
      onChange: s.setSkipForward,
      step: 5,
      min: 5,
      max: 120,
      format: sec,
    },
    {
      label: t('settings.playback.defaultSpeed'),
      value: s.defaultRate,
      onChange: s.setDefaultRate,
      step: 0.05,
      min: 0.5,
      max: 2,
      format: formatSpeed,
    },
    {
      label: t('settings.playback.autoRewind'),
      value: s.autoRewindMax,
      onChange: s.setAutoRewindMax,
      step: 5,
      min: 0,
      max: 30,
      format: secOrOff,
    },
    {
      label: t('settings.playback.chapterLength'),
      value: s.virtualChapterInterval,
      onChange: s.setVirtualChapterInterval,
      step: 300,
      min: 300,
      max: 3600,
      format: mins,
    },
  ];
  return (
    <SettingsCard testID="settings-pane-playback">
      {rows.map(({ label, ...stepper }, i) => (
        <SettingRow key={label} label={label} first={i === 0}>
          <Stepper {...stepper} label={label} />
        </SettingRow>
      ))}
      {/* The same rows as the speed sheet's: one place for each setting. */}
      <EffectsSettings />
    </SettingsCard>
  );
}

function SleepPane() {
  const { t } = useTranslation();
  const autoSleepTimer = useSettings((s) => s.autoSleepTimer);
  const autoSleepFrom = useSettings((s) => s.autoSleepFrom);
  const autoSleepUntil = useSettings((s) => s.autoSleepUntil);
  const autoSleepType = useSettings((s) => s.autoSleepType);
  const setAutoSleepTimer = useSettings((s) => s.setAutoSleepTimer);
  const setAutoSleepFrom = useSettings((s) => s.setAutoSleepFrom);
  const setAutoSleepUntil = useSettings((s) => s.setAutoSleepUntil);
  const setAutoSleepType = useSettings((s) => s.setAutoSleepType);
  const shakeToExtend = useSettings((s) => s.shakeToExtend);
  const setShakeToExtend = useSettings((s) => s.setShakeToExtend);
  // The web has no accelerometer: the row stays, saying so (STYLEGUIDE section 13).
  const canShake = shakeAvailable();
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

  return (
    <SettingsCard testID="settings-pane-sleep">
      <SettingRow
        first
        control="wide"
        label={t('settings.sleep.auto.label')}
        description={t('settings.sleep.auto.description')}
      >
        <OnOff
          value={autoSleepTimer}
          onChange={setAutoSleepTimer}
          label={t('settings.sleep.auto.label')}
        />
      </SettingRow>
      {/* The window and the timer's kind only matter once the feature is on. */}
      {autoSleepTimer ? (
        <>
          <SettingRow label={t('settings.sleep.from')}>
            <TimeStepper
              value={autoSleepFrom}
              onChange={setAutoSleepFrom}
              label={t('settings.sleep.from')}
            />
          </SettingRow>
          <SettingRow label={t('settings.sleep.until')}>
            <TimeStepper
              value={autoSleepUntil}
              onChange={setAutoSleepUntil}
              label={t('settings.sleep.until')}
            />
          </SettingRow>
          {/* Both bounds on the same time is a zero-length window, which
            `withinAutoSleepWindow` reads as NEVER - and the stepper wraps in 30 minute
            steps, so walking "Until" back onto "From" takes one tap. Without this the
            pane shows a feature that is switched on and can never arm, with nothing to
            explain why. */}
          {autoSleepFrom === autoSleepUntil ? (
            <Text variant="caption" className="-mt-1 pb-3">
              {t('settings.sleep.sameTimes')}
            </Text>
          ) : null}
          <SettingRow label={t('settings.sleep.type.label')}>
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
          </SettingRow>
        </>
      ) : null}
      <SettingRow
        control="wide"
        label={t('settings.sleep.shake.label')}
        description={
          canShake ? t('settings.sleep.shake.description') : t('settings.sleep.shake.unavailable')
        }
      >
        {canShake ? (
          <OnOff
            value={shakeToExtend}
            onChange={setShakeToExtend}
            label={t('settings.sleep.shake.label')}
          />
        ) : null}
      </SettingRow>
      {canShake && shakeToExtend ? (
        <SettingRow
          control="wide"
          label={t('settings.sleep.sensitivity.label')}
          description={t('settings.sleep.sensitivity.description')}
        >
          <ShakeSensitivityControl />
        </SettingRow>
      ) : null}
    </SettingsCard>
  );
}

function DownloadsPane() {
  const { t } = useTranslation();
  const autoPlayNext = useSettings((s) => s.autoPlayNext);
  const autoDownloadNext = useSettings((s) => s.autoDownloadNext);
  const autoDeleteFinished = useSettings((s) => s.autoDeleteFinished);
  const setAutoPlayNext = useSettings((s) => s.setAutoPlayNext);
  const setAutoDownloadNext = useSettings((s) => s.setAutoDownloadNext);
  const setAutoDeleteFinished = useSettings((s) => s.setAutoDeleteFinished);
  const downloadOptions = useAutoDownloadModes();
  return (
    <SettingsCard testID="settings-pane-downloads">
      <SettingRow
        first
        control="wide"
        label={t('settings.upNext.autoPlay.label')}
        description={t('settings.upNext.autoPlay.description')}
      >
        <OnOff
          value={autoPlayNext}
          onChange={setAutoPlayNext}
          label={t('settings.upNext.autoPlay.label')}
        />
      </SettingRow>
      {/* The same setting, and words, as the Downloads page's rules card. */}
      <SettingRow
        control="wide"
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
      </SettingRow>
      {/* The same setting as the Downloads page's "Automatic downloads" card. */}
      <SettingRow
        control="wide"
        label={t('downloads.rules.keepAhead.label')}
        description={t('downloads.rules.keepAhead.hint')}
      >
        <View className="gap-1.5">
          <KeepAheadControl grow />
          <KeepAheadStatusLine />
        </View>
      </SettingRow>
      <SettingRow
        control="wide"
        label={t('downloads.rules.autoDelete')}
        description={t('settings.upNext.autoDelete.description')}
      >
        <OnOff
          value={autoDeleteFinished}
          onChange={setAutoDeleteFinished}
          label={t('downloads.rules.autoDelete')}
        />
      </SettingRow>
    </SettingsCard>
  );
}

function AppearancePane() {
  const { t } = useTranslation();
  const { pref, setPref } = useTheme();
  const options = APPEARANCE.map((value) => ({
    value,
    label: t(`settings.appearance.${value}`),
  }));
  return (
    <SettingsCard testID="settings-pane-appearance">
      <SettingRow
        first
        control="wide"
        label={t('settings.appearance.label')}
        description={t('settings.appearance.description')}
      >
        <SegmentedControl
          options={options}
          value={pref}
          onChange={setPref}
          grow
          accessibilityLabel={t('settings.appearance.label')}
        />
      </SettingRow>
    </SettingsCard>
  );
}

function LanguagePane() {
  const { t } = useTranslation();
  const { pref, setPref } = useLanguage();
  // System default first, then each catalog in its own endonym (not translated).
  const languages: { value: LanguagePref; label: string }[] = [
    { value: 'system', label: t('settings.language.system') },
    ...SUPPORTED_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
  ];
  return (
    <SettingsCard testID="settings-pane-language">
      <SettingRow
        first
        control="block"
        label={t('settings.language.label')}
        description={t('settings.language.description')}
      >
        {/* A long list, so the segments wrap onto more lines instead of one row. */}
        <SegmentedControl
          options={languages}
          value={pref}
          onChange={setPref}
          wrap
          accessibilityLabel={t('settings.language.label')}
          className="self-start"
        />
      </SettingRow>
    </SettingsCard>
  );
}

/** Household and sharing: profiles, kids mode and "Listening in the house" arrive with
 * the household phase (8). Until then a quiet notice says so, flagged like any other
 * feature that waits on server work (STYLEGUIDE section 15). */
function HouseholdPane() {
  const { t } = useTranslation();
  return (
    <View className="gap-3" testID="settings-pane-household">
      <Notice
        icon="users"
        title={t('settings.household.title')}
        body={t('settings.household.body')}
      />
      <Badge variant="outline" className="self-start">
        <Text>{t('settings.household.flag')}</Text>
      </Badge>
    </View>
  );
}

/** The signed-in servers (each opening its own Account) and Add a server. */
function AccountsPane({ onRemove }: { onRemove: (c: Connection) => void }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3" testID="settings-pane-accounts">
      <Text variant="muted">{t('settings.accounts.intro')}</Text>
      <ConnectionsSection onRemove={onRemove} />
    </View>
  );
}

/** Support is web/Android only - Apple disallows linking out to an external
 * developer-donation page, and the UK App Store is outside the US/EU carve-outs that now
 * permit it (see src/lib/support.ts). The pane is only offered where it may show. */
function SupportPane() {
  const { t } = useTranslation();
  return (
    <Card className="gap-3" testID="settings-pane-support">
      <Text variant="muted">{t('settings.support.intro')}</Text>
      <Button
        title={t('settings.support.cta')}
        icon="heart"
        variant="secondary"
        onPress={() => void openSupport()}
        className="self-start"
      />
    </Card>
  );
}

/** One pane's body. */
export function SettingsPaneBody({
  pane,
  onRemoveConnection,
}: {
  pane: SettingsPane;
  onRemoveConnection: (c: Connection) => void;
}) {
  switch (pane) {
    case 'playback':
      return <PlaybackPane />;
    case 'sleep':
      return <SleepPane />;
    case 'downloads':
      return <DownloadsPane />;
    case 'appearance':
      return <AppearancePane />;
    case 'language':
      return <LanguagePane />;
    case 'household':
      return <HouseholdPane />;
    case 'accounts':
      return <AccountsPane onRemove={onRemoveConnection} />;
    case 'support':
      return <SupportPane />;
  }
}
