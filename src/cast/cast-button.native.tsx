import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';
import GoogleCast, { CastButton as SdkCastButton } from 'react-native-google-cast';

import { pillClass } from '@/components/player/control-pill';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  type CastButtonProps,
  castButtonWhenSupported,
  castLabel,
  DrawnCastButton,
  explainBlocked,
} from './cast-button-parts';
import { sdkButtonDraws } from './cast-button-model';
import { useCastButton } from './use-cast-button';

/**
 * The Cast button on iOS and Android: the Cast SDK's own button (react-native-google-cast's
 * `CastButton`: it opens the SDK's device chooser, starts discovery on its first tap and
 * shows the session's state), in the player's pill. Shown only when the book's server has
 * `cast` and this binary has the Cast module (see `useCastButton`), and only while the SDK's
 * button draws (`useSdkButtonDraws`: it hides itself while no Cast device is found, which
 * left an empty pill). A book that can't be cast gets a button of ours instead that says why.
 */
export const CastButton = castButtonWhenSupported(ShownCastButton);

function ShownCastButton(props: CastButtonProps) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const model = useCastButton();
  const draws = useSdkButtonDraws();
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
  if (!draws) return null;
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

/** How often (ms) iOS asks whether discovery has started while it has not (`useSdkButtonDraws`). */
const DISCOVERY_CHECK_MS = 2_000;

/**
 * Whether the SDK's Cast button draws its icon now (`sdkButtonDraws`): the SDK's cast state
 * as it changes and, on iOS, whether discovery runs. Discovery starting (the button's first
 * tap) has no event of its own, so while the button draws only because it has not started,
 * iOS asks again every `DISCOVERY_CHECK_MS`. A read that fails or never answers (Android's
 * getters can hang) leaves the button drawn, as it always was.
 */
function useSdkButtonDraws(): boolean {
  const [state, setState] = useState<string | null>(null);
  const [running, setRunning] = useState<boolean | null>(null);
  const ios = Platform.OS === 'ios';
  useEffect(() => {
    let live = true;
    // A change the listener told is newer than a first read that lands after it.
    let heard = false;
    const readRunning = () => {
      if (!ios) return;
      GoogleCast.getDiscoveryManager()
        .isRunning()
        .then(
          (r) => {
            if (live) setRunning(r);
          },
          () => undefined,
        );
    };
    GoogleCast.getCastState().then(
      (s) => {
        if (live && !heard) setState(s ?? null);
      },
      () => undefined,
    );
    readRunning();
    const sub = GoogleCast.onCastStateChanged((s) => {
      heard = true;
      setState(s);
      readRunning();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [ios]);
  const waiting = ios && state === 'noDevicesAvailable' && running === false;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const timer = setInterval(() => {
      GoogleCast.getDiscoveryManager()
        .isRunning()
        .then(
          (r) => {
            if (live) setRunning(r);
          },
          () => undefined,
        );
    }, DISCOVERY_CHECK_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waiting]);
  return sdkButtonDraws(state, Platform.OS, running);
}

const styles = StyleSheet.create({ compact: { width: 44, height: 44, margin: -4 } });
