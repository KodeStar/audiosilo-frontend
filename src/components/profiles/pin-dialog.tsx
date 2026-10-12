import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, type TextInput, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import {
  checkPin,
  isValidPin,
  notePinTry,
  PIN_LENGTH,
  PIN_LOCK_MS,
  pinLockedFor,
  setPin,
  type StoredPin,
} from '@/lib/profile-pin';
import { useNow } from '@/lib/use-now';

import { waitSeconds } from './profiles-model';

export type PinDialogMode = 'check' | 'set';

/**
 * The profile PIN prompt (Phase 8), in the shared Dialog (a bottom sheet on a phone that
 * lifts above the software keyboard on iOS and Android).
 *
 * - `check`: "Enter <name>'s PIN". Four digits submit by themselves. A wrong PIN shakes
 *   the field (still with reduced motion: then no movement, the words say it) and says
 *   "That PIN doesn't match"; the fifth wrong try in a row makes the prompt wait 30
 *   seconds (`pinLockedFor`, kept per profile in memory, so closing the prompt doesn't
 *   reset it). `onDone` once it matches.
 * - `set`: choose four digits, then enter them again; `onDone` once saved (`setPin`).
 *
 * The caller owns visibility and what happens after (switch, change, remove).
 *
 * However it closes (a right PIN, a saved one, Cancel, the close button, the backdrop,
 * Android's back), the field gives the keyboard up FIRST (`releaseKeyboard`), while it is
 * still on screen and focused. Left to its unmount, the field was removed with the number
 * pad up: Android kept the keyboard shown on the window's fallback input (a full QWERTY
 * keyboard with no field) over "Who's listening?" and then Home, every time.
 */
export function PinDialog({
  open,
  mode,
  profileId,
  stored,
  name,
  title,
  onDone,
  onCancel,
}: {
  open: boolean;
  mode: PinDialogMode;
  profileId: string;
  /** `check`: the PIN as the caller just read it (`readPin`), so the check doesn't read
   * the secure store again. Absent: the check reads it. */
  stored?: StoredPin;
  /** The person's name, for the title and the field's label. */
  name: string;
  /** A title of the caller's ("Enter your current PIN"), else the mode's. */
  title?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        releaseKeyboard();
        onCancel();
      }}
    >
      {open ? (
        <PinDialogBody
          // A new step (check, then set) starts empty.
          key={mode}
          mode={mode}
          profileId={profileId}
          stored={stored}
          name={name}
          title={title}
          onDone={onDone}
          onCancel={onCancel}
        />
      ) : null}
    </Dialog>
  );
}

/** Blur the focused field (the PIN's) and close the software keyboard. Before the prompt
 * closes, never after: a field already being removed can't hide it any more on Android. */
function releaseKeyboard(): void {
  Keyboard.dismiss();
}

/** Mounted only while open, so each opening starts empty. */
function PinDialogBody({
  mode,
  profileId,
  stored,
  name,
  title,
  onDone,
  onCancel,
}: Omit<Parameters<typeof PinDialog>[0], 'open'>) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [pin, setPinValue] = useState('');
  /** `set`: the first entry, waiting for the same again. */
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState(() => {
    const wait = pinLockedFor(profileId);
    return wait > 0 ? Date.now() + wait : 0;
  });
  const now = useNow(1000, lockedUntil > 0);
  const waiting = lockedUntil > now;
  const field = useRef<TextInput>(null);
  // The field stays editable while a PIN is checked (10,000 hash rounds): a field that
  // turns non-editable loses focus on native, the keyboard closes and the sheet drops, so
  // the next try needed a tap first. Input that arrives meanwhile is ignored (`onChange`).
  // After a wrong PIN, and when a wait is over, it has the focus (and the keyboard) again,
  // never once the prompt is closing (`leave`): a check still running when Cancel was
  // pressed would bring the keyboard back over the screen under it (or, right, switch).
  const closed = useRef(false);
  // Closed from outside too (the close button, the backdrop, back): a check that lands
  // after it neither refocuses nor switches. (Reset on mount for Strict Mode's remount.)
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  const refocus = () => {
    if (!closed.current) field.current?.focus();
  };
  /** Close the prompt (done or cancelled): the keyboard goes first, then the caller acts
   * (switches person, navigates, opens the next step). */
  const leave = (then: () => void) => {
    closed.current = true;
    field.current?.blur();
    releaseKeyboard();
    then();
  };
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (wasWaiting.current && !waiting) refocus();
    wasWaiting.current = waiting;
  }, [waiting]);
  const offset = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));

  const shake = () => {
    if (reduced) return;
    offset.set(
      withSequence(
        withTiming(-10, { duration: 50 }),
        withTiming(10, { duration: 60 }),
        withTiming(-7, { duration: 60 }),
        withTiming(7, { duration: 60 }),
        withTiming(0, { duration: 50 }),
      ),
    );
  };

  const submitCheck = async (value: string) => {
    if (pinLockedFor(profileId) > 0) return;
    setBusy(true);
    let right = false;
    try {
      right = await checkPin(profileId, value, stored);
    } catch {
      if (closed.current) return;
      setBusy(false);
      setPinValue('');
      setError(t('profiles.pin.readFailed'));
      return;
    }
    notePinTry(profileId, right);
    if (closed.current) return;
    setBusy(false);
    if (right) {
      leave(onDone);
      return;
    }
    setPinValue('');
    shake();
    refocus();
    const wait = pinLockedFor(profileId);
    if (wait > 0) {
      // The wait says it all, and nothing once it is over.
      setLockedUntil(Date.now() + wait);
      setError(null);
    } else {
      setError(t('profiles.pin.wrong'));
    }
  };

  const submitSet = async (value: string) => {
    if (first === null) {
      setFirst(value);
      setPinValue('');
      setError(null);
      return;
    }
    if (value !== first) {
      setFirst(null);
      setPinValue('');
      shake();
      refocus();
      setError(t('profiles.pin.mismatch'));
      return;
    }
    setBusy(true);
    try {
      await setPin(profileId, value);
      if (!closed.current) leave(onDone);
    } catch {
      if (closed.current) return;
      setError(t('profiles.pin.saveFailed'));
      setFirst(null);
      setPinValue('');
    } finally {
      setBusy(false);
    }
  };

  const onChange = (raw: string) => {
    if (busy) return;
    const digits = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPinValue(digits);
    if (digits.length > 0 && error && !waiting) setError(null);
    if (isValidPin(digits) && !busy && !waiting) {
      void (mode === 'check' ? submitCheck(digits) : submitSet(digits));
    }
  };

  const heading =
    title ??
    (mode === 'check'
      ? t('profiles.pin.enterTitle', { name })
      : first === null
        ? t('profiles.pin.chooseTitle')
        : t('profiles.pin.confirmTitle'));
  const description =
    mode === 'check' ? t('profiles.pin.enterBody') : t('profiles.pin.chooseBody', { name });
  // `now` is the clock's last tick, up to a second old when the wait starts: never more
  // than the wait itself.
  const remaining = waitSeconds(Math.min(lockedUntil - now, PIN_LOCK_MS));

  return (
    <DialogContent>
      <View className="flex-row items-start gap-3.5">
        <DialogIcon name="key" />
        <DialogHeader className="flex-1">
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
      </View>
      <Animated.View style={shakeStyle}>
        <Input
          testID="pin-field"
          size="lg"
          value={pin}
          onChangeText={onChange}
          keyboardType="number-pad"
          inputMode="numeric"
          secureTextEntry
          maxLength={PIN_LENGTH}
          autoFocus
          autoComplete="off"
          textContentType="none"
          ref={field}
          editable={!waiting}
          accessibilityLabel={t('profiles.pin.fieldLabel', { name })}
          className="text-center font-mono text-2xl tracking-[0.6em]"
        />
      </Animated.View>
      <View className="min-h-[20px]" accessibilityLiveRegion="assertive">
        {waiting ? (
          <Text variant="caption" className="text-center text-destructive" role="alert">
            {t('profiles.pin.wait', { count: remaining })}
          </Text>
        ) : error ? (
          <Text variant="caption" className="text-center text-destructive" role="alert">
            {error}
          </Text>
        ) : mode === 'check' ? (
          <Text variant="caption" className="text-center">
            {t('profiles.pin.forgot', { name })}
          </Text>
        ) : null}
      </View>
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={() => leave(onCancel)} />
      </DialogFooter>
    </DialogContent>
  );
}
