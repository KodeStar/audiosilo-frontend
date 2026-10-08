import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { supportsVoiceBoost } from '@/playback/effects';
import { usePlayer } from '@/playback/store';
import { useTimeSaved } from '@/playback/time-saved';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';

import {
  effectsPill,
  type EffectRow,
  type EffectsPill,
  type SmartSpeedLine,
  smartSpeedRow,
  type VoiceBoostLine,
  voiceBoostRow,
} from './effects-model';

/** Each switch's caption keys, by line (`saved` carries the time, so it is worded apart). */
const SMART_SPEED_LINES = {
  hint: 'effects.smartSpeed.hint',
  downloadedOnly: 'effects.smartSpeed.downloadedOnly',
  notInBrowser: 'effects.smartSpeed.notInBrowser',
} as const satisfies Record<Exclude<SmartSpeedLine, 'saved'>, string>;
const VOICE_BOOST_LINES = {
  hint: 'effects.voiceBoost.hint',
  notInThisBrowser: 'effects.voiceBoost.notInThisBrowser',
} as const satisfies Record<VoiceBoostLine, string>;

/** Voice Boost can run here (native always; the web outside Safari). */
function voiceBoostSupported(): boolean {
  return Platform.OS !== 'web' || supportsVoiceBoost();
}

/**
 * The Smart Speed and Voice Boost switches, bound to the one `smartSpeed` / `voiceBoost`
 * settings: the speed sheet and Settings > Listening > Playback both show THIS component,
 * so each setting lives in one place. Rows look like Settings' own (`SettingRow`): label
 * and captions on the left, the switch on the right, a hairline above unless `first`.
 */
export function EffectsSettings({ first = false }: { first?: boolean }) {
  const { t } = useTranslation();
  const smartSpeed = useSettings((s) => s.smartSpeed);
  const voiceBoost = useSettings((s) => s.voiceBoost);
  const setSmartSpeed = useSettings((s) => s.setSmartSpeed);
  const setVoiceBoost = useSettings((s) => s.setVoiceBoost);
  const queue = usePlayer((s) => s.nowPlaying?.queue ?? null);
  const saved = useTimeSaved();

  const smart = smartSpeedRow({
    platform: Platform.OS,
    on: smartSpeed,
    savedSeconds: saved,
    queue,
  });
  const boost = voiceBoostRow({
    platform: Platform.OS,
    on: voiceBoost,
    supported: voiceBoostSupported(),
  });
  const smartWords = (line: SmartSpeedLine): string =>
    line === 'saved'
      ? t('effects.saved', { time: formatDuration(saved) })
      : t(SMART_SPEED_LINES[line]);
  const boostWords = (line: VoiceBoostLine): string => t(VOICE_BOOST_LINES[line]);

  return (
    <View testID="effects-settings">
      <EffectSwitchRow
        first={first}
        label={t('effects.smartSpeed.label')}
        row={smart}
        words={smartWords}
        onChange={setSmartSpeed}
        testID="effects-smart-speed"
      />
      <EffectSwitchRow
        label={t('effects.voiceBoost.label')}
        row={boost}
        words={boostWords}
        onChange={setVoiceBoost}
        testID="effects-voice-boost"
      />
    </View>
  );
}

function EffectSwitchRow<Line extends string>({
  label,
  row,
  words,
  onChange,
  first = false,
  testID,
}: {
  label: string;
  row: EffectRow<Line>;
  words: (line: Line) => string;
  onChange: (on: boolean) => void;
  first?: boolean;
  testID: string;
}) {
  return (
    <View
      className={cn(
        'flex-row items-center justify-between gap-4 py-3.5',
        !first && 'border-t border-border',
      )}
    >
      <View className="min-w-0 shrink gap-0.5">
        <Text>{label}</Text>
        {row.lines.map((line) => (
          <Text key={line} variant="caption" style={line === 'saved' ? tabularNums : undefined}>
            {words(line)}
          </Text>
        ))}
      </View>
      <Switch
        checked={row.checked}
        onCheckedChange={onChange}
        disabled={row.disabled}
        accessibilityLabel={label}
        // The reason it is off (the web) or what it does, read with the switch.
        accessibilityHint={row.lines.map(words).join('. ')}
        testID={testID}
      />
    </View>
  );
}

/** The full player's effects state (`effectsPill`), or null when nothing is on. */
export function useEffectsPill(): { pill: EffectsPill; text: string; label: string } | null {
  const { t } = useTranslation();
  const smartSpeed = useSettings((s) => s.smartSpeed);
  const voiceBoost = useSettings((s) => s.voiceBoost);
  const saved = useTimeSaved();
  const pill = effectsPill({
    platform: Platform.OS,
    smartSpeed,
    voiceBoost,
    voiceBoostSupported: voiceBoostSupported(),
    savedSeconds: saved,
  });
  if (!pill) return null;
  const text =
    pill.kind === 'saved'
      ? t('effects.saved', { time: formatDuration(pill.seconds) })
      : pill.kind === 'voiceBoost'
        ? t('effects.voiceBoost.label')
        : t('effects.smartSpeed.label');
  return { pill, text, label: t('effects.pillLabel', { state: text }) };
}
