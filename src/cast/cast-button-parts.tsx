import type { TFunction } from 'i18next';

import { ControlPill, type PillLook } from '@/components/player/control-pill';
import { toast } from '@/components/ui/toast';
import { useThemeColors } from '@/theme/use-theme-colors';

import { CastGlyph } from './cast-glyph';
import type { CastBlockReason } from './cast-media';
import type { CastButtonModel } from './cast-button-model';

/** Where a Cast button sits: the full player's action row (an outline pill) or the docked
 * player's (a ghost pill). The caller passes its own row's size and slop, so the button
 * matches its neighbours. */
export type CastButtonProps = {
  look?: PillLook;
  className?: string;
  hitSlop?: number;
  /** The docked player's 36 pt row: the SDK's own button keeps a 44 pt frame around it. */
  compact?: boolean;
  testID?: string;
};

/** Explain why this book can't be cast. */
export function explainBlocked(t: TFunction, reason: CastBlockReason) {
  toast({ title: t('cast.blocked.title'), description: t(`cast.blocked.${reason}`) });
}

/** The button's screen-reader label: casting, connecting or connected to a device. */
export function castLabel(t: TFunction, model: CastButtonModel): string {
  if (model.status === 'connected') {
    return model.deviceName
      ? t('cast.button.connectedTo', { device: model.deviceName })
      : t('cast.button.connected');
  }
  if (model.status === 'connecting') return t('cast.button.connecting');
  return t('cast.button.label');
}

/** A Cast button the app draws itself (the web's, and native's "can't cast this" one). */
export function DrawnCastButton({
  model,
  label,
  onPress,
  look = 'ghost',
  className,
  hitSlop,
  testID,
}: CastButtonProps & { model: CastButtonModel; label: string; onPress: () => void }) {
  const themed = useThemeColors();
  return (
    <ControlPill
      look={look}
      className={className}
      hitSlop={hitSlop}
      label={label}
      onPress={onPress}
      testID={testID}
    >
      <CastGlyph
        size={17}
        color={model.blocked ? themed.mutedForeground : themed.foreground}
        connected={model.status === 'connected'}
      />
    </ControlPill>
  );
}
