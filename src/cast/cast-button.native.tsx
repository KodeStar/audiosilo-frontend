import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { CastButton as SdkCastButton } from 'react-native-google-cast';

import { pillClass } from '@/components/player/control-pill';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  type CastButtonProps,
  castLabel,
  DrawnCastButton,
  explainBlocked,
} from './cast-button-parts';
import { useCast } from './cast-state';
import { useCastButton } from './use-cast-button';

/**
 * The Cast button on iOS and Android: the Cast SDK's own button (react-native-google-cast's
 * `CastButton`: it opens the SDK's device chooser, starts discovery on its first tap and
 * shows the session's state), in the player's pill. Shown only when the book's server has
 * `cast` and this binary has the Cast module (see `useCastButton`). A book that can't be
 * cast gets a button of ours instead that says why.
 */
export function CastButton(props: CastButtonProps) {
  // Nothing (and no server read) on a device that can't cast.
  const supported = useCast((s) => s.supported);
  return supported ? <ShownCastButton {...props} /> : null;
}

function ShownCastButton(props: CastButtonProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const model = useCastButton();
  if (!model.show) return null;
  const label = castLabel(t, model);
  if (model.blocked) {
    const reason = model.blocked;
    return (
      <DrawnCastButton
        {...props}
        model={model}
        label={t('cast.button.blockedLabel')}
        onPress={() => explainBlocked(t, reason)}
      />
    );
  }
  const sdk = (
    <SdkCastButton
      accessibilityLabel={label}
      tintColor={themed.foreground}
      style={StyleSheet.absoluteFill}
    />
  );
  // The SDK's button is a native view: its frame is its touch target, so it gets a real
  // 44 pt one (the docked row is 36 pt: the frame overhangs it by 4 pt each side).
  return props.compact ? (
    <View testID={props.testID} style={styles.compact}>
      {sdk}
    </View>
  ) : (
    <View testID={props.testID} className={pillClass(props.look ?? 'ghost', props.className)}>
      {sdk}
    </View>
  );
}

const styles = StyleSheet.create({ compact: { width: 44, height: 44, margin: -4 } });
