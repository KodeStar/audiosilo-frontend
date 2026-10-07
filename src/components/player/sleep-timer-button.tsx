import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Chapter } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { chapterLabel } from '@/lib/chapter-label';
import { formatClock, formatDuration, formatTimeOfDay, formatWallClock } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { noteInteraction } from '@/playback/last-interaction';
import {
  chapterTimerTarget,
  selectSleepExtendable,
  selectSleepPhase,
  useSleepTimer,
} from '@/playback/sleep-timer';
import { selectBookPosition, selectCurrentChapter, usePlayer } from '@/playback/store';
import { shakeAvailable } from '@/playback/use-shake-to-extend';
import { SHAKE_SENSITIVITIES, useSettings, type ShakeSensitivity } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { ControlPill } from './control-pill';
import { OptionTile } from './option-tile';
import { PlayerSheet } from './player-sheet';
import {
  isDurationTimer,
  SLEEP_MINUTES,
  sleepNotice,
  stopAfterLabel,
  stopAfterRows,
  stopsAt,
} from './sleep-sheet-model';
import { useSleepPill } from './use-sleep-countdown';

/**
 * The dock's sleep pill (`useSleepPill`): the moon alone while idle; with a timer its
 * countdown on `brand-soft` (STYLEGUIDE section 8, the dock's sleep control), and "Keep
 * going" once the timer has paused playback. It opens the sleep sheet through
 * `usePlayerSheets`.
 */
export function SleepTimerButton({ onPress }: { onPress: () => void }) {
  const themed = useThemeColors();
  const { active, text, label } = useSleepPill();
  return (
    <ControlPill
      onPress={onPress}
      look={active ? 'active' : 'ghost'}
      className={cn('h-9 flex-row gap-1.5', active ? 'px-3' : 'px-2')}
      hitSlop={6}
      label={label}
    >
      <Icon name="sleep" size={18} color={active ? themed.brandInk : themed.foreground} />
      {text ? (
        <Text variant="label" className="text-brand-ink" style={tabularNums}>
          {text}
        </Text>
      ) : null}
    </ControlPill>
  );
}

/**
 * The sleep timer sheet (STYLEGUIDE section 8, "Sheets" > Sleep): the running timer's
 * notice (with Turn off, and Keep listening in its last seconds), the minute presets and
 * End of chapter, "Or stop after" this chapter and the next ones with their end times,
 * then the sleep settings (auto sleep, shake to extend and its sensitivity) and the
 * "Fell asleep" note. Picking a timer arms it and closes the sheet.
 */
export function SleepSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <PlayerSheet visible={visible} onClose={onClose} title={t('player.sleepTimer.title')}>
      <SleepSheetBody onClose={onClose} />
    </PlayerSheet>
  );
}

/** How finely the sleep sheet follows the place: its times are minutes ("in 12m", "ends
 * 22:49"), and the chapter tile's 30-second rule needs no finer than this. */
const SHEET_POSITION_STEP = 15;

/** The body, mounted only while the sheet is open (it follows the position, by
 * `SHEET_POSITION_STEP`). */
function SleepSheetBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const phase = useSleepTimer(selectSleepPhase);
  const origin = useSleepTimer((s) => s.origin);
  const pauseAtPosition = useSleepTimer((s) => s.pauseAtPosition);
  const startDuration = useSleepTimer((s) => s.startDuration);
  const startUntilPosition = useSleepTimer((s) => s.startUntilPosition);
  const startChapterTimer = useSleepTimer((s) => s.startChapterTimer);
  const queue = usePlayer((s) => s.nowPlaying?.queue ?? null);
  const position = usePlayer(
    (s) => Math.floor(selectBookPosition(s) / SHEET_POSITION_STEP) * SHEET_POSITION_STEP,
  );
  const rate = usePlayer((s) => s.rate);

  /** Arm (a deliberate touch, for the drift-off prompt) and close. */
  const pick = (arm: () => void) => {
    arm();
    noteInteraction();
    onClose();
  };

  // The tile arms exactly what `startChapterTimer` would, so it shows that target's
  // countdown: the next chapter end at least 30 s away, else the end of the book.
  const chapterTarget = queue ? chapterTimerTarget(queue, position, rate, true) : null;
  const rows = queue ? stopAfterRows(queue, position, rate) : [];
  // The wall clock, every 15 s: enough for the rows' "ends 22:49".
  const now = useNow(15_000);

  return (
    <View className="gap-4 pt-1">
      {phase !== 'idle' ? <SleepNotice /> : null}

      <View
        role="radiogroup"
        accessibilityLabel={t('player.sleepTimer.title')}
        className="flex-row flex-wrap gap-2"
      >
        {SLEEP_MINUTES.map((m) => (
          <OptionTile
            key={m}
            title={String(m)}
            caption={t('player.sleepTimer.minutesUnit', { count: m })}
            accessibilityLabel={t('player.sleepTimer.minutes', { count: m })}
            selected={isDurationTimer(phase, origin, m)}
            onPress={() => pick(() => startDuration(m))}
            className="grow basis-[21%]"
          />
        ))}
        {chapterTarget ? (
          <OptionTile
            title={
              chapterTarget.label.key === 'player.sleepTimer.endOfBook'
                ? t('player.sleepTimer.endOfBook')
                : t('player.sleepTimer.endOfChapter')
            }
            caption={t('player.sleepTimer.inTime', {
              time: formatDuration(chapterTarget.untilEnd),
            })}
            selected={stopsAt(phase, pauseAtPosition, chapterTarget.position)}
            onPress={() => pick(() => startChapterTimer({ allowEndOfBook: true }))}
            className="grow-[2] basis-[42%]"
          />
        ) : null}
      </View>

      {rows.length > 0 ? (
        <View className="gap-1.5">
          <Text variant="eyebrow">{t('player.sleepTimer.stopAfter')}</Text>
          {rows.map((row) => {
            const name =
              row.count === 1
                ? t('player.sleepTimer.thisChapter')
                : t('player.sleepTimer.nChapters', { count: row.count });
            const chapter = chapterLabel(row.chapter, t);
            const ends = t('player.sleepTimer.endsAt', {
              time: formatWallClock(new Date(now + row.untilEnd * 1000)),
            });
            const length = formatDuration(row.untilEnd);
            const selected = stopsAt(phase, pauseAtPosition, row.endPosition);
            return (
              <PressableRow
                key={row.chapter.index}
                onPress={() => pick(() => startUntilPosition(row.endPosition, stopAfterLabel(row)))}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${name}, ${chapter}, ${ends}, ${length}`}
                className={cn(
                  'min-h-[48px] flex-row items-center gap-3 px-3.5 py-2.5',
                  selected && 'border-primary',
                )}
              >
                <Text numberOfLines={1} className="flex-1">
                  <Text variant="label">{name}</Text>
                  <Text variant="muted">{` · ${chapter}`}</Text>
                </Text>
                <Text variant="caption" style={tabularNums}>
                  {`${ends} · ${length}`}
                </Text>
              </PressableRow>
            );
          })}
        </View>
      ) : null}

      <SleepSettingsCard />

      <Text variant="caption">{t('player.sleepTimer.fellAsleepHint')}</Text>
    </View>
  );
}

const NO_CHAPTERS: Chapter[] = [];

/** The armed timer: what it will do, how long is left, Turn off - and Keep listening in
 * the two windows where that keeps the book going (the web has no shake). */
function SleepNotice() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phase = useSleepTimer(selectSleepPhase);
  const origin = useSleepTimer((s) => s.origin);
  const label = useSleepTimer((s) => s.label);
  const remaining = useSleepTimer((s) => s.remaining);
  const pauseAtPosition = useSleepTimer((s) => s.pauseAtPosition);
  const keepListening = useSleepTimer((s) => s.keepListening);
  const cancel = useSleepTimer((s) => s.cancel);
  const chapters = usePlayer((s) => s.nowPlaying?.queue.chapters ?? NO_CHAPTERS);
  // The chapters left to the stop only change as a chapter goes by: count from the start
  // of the one playing, not the per-tick position.
  const chapterStart = usePlayer((s) => selectCurrentChapter(s)?.book_offset ?? 0);

  const notice = sleepNotice(origin, label, pauseAtPosition, chapters, chapterStart);
  const headline =
    phase === 'grace'
      ? t('player.sleepTimer.grace.pausedTitle')
      : notice.kind === 'duration'
        ? t('player.sleepTimer.notice.on')
        : notice.kind === 'book'
          ? t('player.sleepTimer.notice.book')
          : t('player.sleepTimer.notice.chapters', { count: notice.count });
  const time = formatClock(remaining ?? 0);
  // Only a duration timer fades out (see `fadesAudio` in sleep-timer.ts), so only it
  // may say so: a chapter timer plays its last 30 seconds at full volume.
  const detail =
    phase === 'grace'
      ? t('player.sleepTimer.notice.graceLeft', { time })
      : origin?.kind === 'duration'
        ? t('player.sleepTimer.notice.leftFades', { time })
        : t('player.sleepTimer.notice.left', { time });
  const extendable = useSleepTimer(selectSleepExtendable);

  return (
    <View className="gap-3 rounded-card border border-brand/25 bg-brand-soft px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <View
          className="h-10 w-10 items-center justify-center rounded-xl bg-card"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          <Icon name="sleep" size={18} color={themed.brandInk} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text variant="label">{headline}</Text>
          <Text variant="caption" style={tabularNums}>
            {detail}
          </Text>
        </View>
        {extendable ? null : (
          <Button
            variant="outline"
            size="sm"
            title={t('player.sleepTimer.turnOff')}
            onPress={cancel}
          />
        )}
      </View>
      {extendable ? (
        <View className="flex-row gap-2">
          <Button
            className="flex-1"
            title={t('player.sleepTimer.keepListening')}
            onPress={keepListening}
          />
          <Button variant="outline" title={t('player.sleepTimer.turnOff')} onPress={cancel} />
        </View>
      ) : null}
    </View>
  );
}

/** One switch row of the sleep settings card. */
function SettingRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  first,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  first?: boolean;
}) {
  return (
    <View
      className={cn(
        'min-h-[56px] flex-row items-center gap-3 py-3',
        !first && 'border-t border-border',
      )}
    >
      <View className="flex-1 gap-0.5">
        <Text variant="label">{title}</Text>
        <Text variant="caption">{description}</Text>
      </View>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        accessibilityLabel={title}
      />
    </View>
  );
}

/** The shake sensitivity choice (Low / Medium / High), shared by the sleep sheet and
 * Settings so both name it the same way. Native only; the caller hides it on the web. */
export function ShakeSensitivityControl() {
  const { t } = useTranslation();
  const value = useSettings((s) => s.shakeSensitivity);
  const set = useSettings((s) => s.setShakeSensitivity);
  const options = SHAKE_SENSITIVITIES.map((v) => ({
    value: v,
    label: t(`settings.sleep.sensitivity.${v}`),
  }));
  return (
    <SegmentedControl<ShakeSensitivity>
      options={options}
      value={value}
      onChange={set}
      grow
      accessibilityLabel={t('settings.sleep.sensitivity.label')}
    />
  );
}

/** Auto sleep and shake to extend, in place (the same settings as Settings > Sleep). */
function SleepSettingsCard() {
  const { t } = useTranslation();
  const autoSleep = useSettings((s) => s.autoSleepTimer);
  const setAutoSleep = useSettings((s) => s.setAutoSleepTimer);
  const from = useSettings((s) => s.autoSleepFrom);
  const until = useSettings((s) => s.autoSleepUntil);
  const type = useSettings((s) => s.autoSleepType);
  const shake = useSettings((s) => s.shakeToExtend);
  const setShake = useSettings((s) => s.setShakeToExtend);
  const web = !shakeAvailable();

  const window = { from: formatTimeOfDay(from), until: formatTimeOfDay(until) };
  const autoDescription =
    type === 'chapter'
      ? t('player.sleepTimer.autoChapter', window)
      : t('player.sleepTimer.autoMinutes', { ...window, count: Number(type) });

  return (
    <Card className="px-4 py-0">
      <SettingRow
        first
        title={t('settings.sleep.auto.label')}
        description={autoDescription}
        checked={autoSleep}
        onChange={setAutoSleep}
      />
      <SettingRow
        title={t('settings.sleep.shake.label')}
        description={
          web ? t('settings.sleep.shake.unavailable') : t('settings.sleep.shake.description')
        }
        checked={!web && shake}
        onChange={setShake}
        disabled={web}
      />
      {!web && shake ? (
        <View className="gap-2 pb-3.5">
          <Text variant="caption">{t('settings.sleep.sensitivity.label')}</Text>
          <ShakeSensitivityControl />
        </View>
      ) : null}
    </Card>
  );
}
