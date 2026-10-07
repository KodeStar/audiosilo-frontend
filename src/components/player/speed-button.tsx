import { useTranslation } from 'react-i18next';
import { Text as RNText, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Text } from '@/components/ui/text';
import { formatDuration, formatSpeed } from '@/lib/format';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { timeLeft } from '@/playback/time-left';
import { tabularNums } from '@/theme/tabular-nums';

import { OptionTile } from './option-tile';
import { PlayerSheet } from './player-sheet';
import {
  isSpeed,
  snapSpeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_PRESETS,
  SPEED_STEP,
  steppedRate,
} from './speed-model';

/**
 * Speed readout button. The sheet is mounted separately (`SpeedSheet`) at the
 * player's root so it presents over the whole screen - a sheet nested here in the
 * footer would be clipped to the footer's bounds.
 */
export function SpeedButton({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);

  return (
    <AnimatedPressable
      onPress={onPress}
      hitSlop={8}
      className="rounded-full px-2 py-1"
      accessibilityRole="button"
      accessibilityLabel={t('player.speed.title')}
    >
      <RNText className="font-sans-medium text-base text-foreground">{formatSpeed(rate)}</RNText>
    </AnimatedPressable>
  );
}

/**
 * The playback-speed sheet (STYLEGUIDE section 8, "Sheets"): the big readout, how long
 * the rest of the book takes at this speed ("remembered for this book": the store saves
 * the speed with the book's progress), a 0.5-2.0 slider in 0.05 steps between minus and
 * plus buttons, and the presets, each with the time left at that speed.
 */
export function SpeedSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <PlayerSheet visible={visible} onClose={onClose} title={t('player.speed.title')}>
      <SpeedSheetBody />
    </PlayerSheet>
  );
}

/** The body, in its own component so its per-tick position subscription only runs
 * while the sheet is open (`PlayerSheet` mounts children only then). */
function SpeedSheetBody() {
  const { t } = useTranslation();
  const rate = usePlayer((s) => s.rate);
  const setRate = usePlayer((s) => s.setRate);
  const total = usePlayer((s) => s.nowPlaying?.queue.total ?? 0);
  const position = usePlayer(selectBookPosition);
  const apply = (next: number) => void setRate(snapSpeed(next));
  const left = (speed: number) => formatDuration(timeLeft(position, total, speed)?.seconds);

  return (
    <View className="gap-4 pt-1">
      <View className="items-center gap-0.5">
        <Text variant="stat" className="text-5xl leading-tight">
          {formatSpeed(rate)}
        </Text>
        {total > 0 ? (
          <Text variant="caption" className="text-center" style={tabularNums}>
            {t('player.speed.leftInBook', { time: left(rate), speed: formatSpeed(rate) })}
          </Text>
        ) : null}
      </View>

      <View className="flex-row items-center gap-2.5">
        <Button
          variant="outline"
          size="icon"
          icon="minus"
          onPress={() => void setRate(steppedRate(rate, -1))}
          disabled={rate <= SPEED_MIN}
          accessibilityLabel={t('player.speed.slower')}
          className="h-11 w-11"
        />
        {/* The slider runs in hundredths so its integer aria values are exact (it rounds
            them for the seek bar's seconds); the value text says "1.25x". */}
        <Slider
          className="flex-1"
          value={Math.round(rate * 100)}
          min={SPEED_MIN * 100}
          max={SPEED_MAX * 100}
          step={SPEED_STEP * 100}
          onValueCommit={(v) => apply(v / 100)}
          accessibilityLabel={t('player.speed.title')}
          valueText={(v) => formatSpeed(snapSpeed(v / 100))}
        />
        <Button
          variant="outline"
          size="icon"
          icon="plus"
          onPress={() => void setRate(steppedRate(rate, 1))}
          disabled={rate >= SPEED_MAX}
          accessibilityLabel={t('player.speed.faster')}
          className="h-11 w-11"
        />
      </View>

      <View
        role="radiogroup"
        accessibilityLabel={t('player.speed.presets')}
        className="flex-row flex-wrap gap-2"
      >
        {SPEED_PRESETS.map((speed) => (
          <OptionTile
            key={speed}
            title={formatSpeed(speed)}
            caption={total > 0 ? left(speed) : undefined}
            accessibilityLabel={
              total > 0
                ? t('player.speed.presetLabel', { speed: formatSpeed(speed), time: left(speed) })
                : formatSpeed(speed)
            }
            selected={isSpeed(rate, speed)}
            onPress={() => apply(speed)}
            className="grow basis-[21%]"
          />
        ))}
      </View>
    </View>
  );
}
