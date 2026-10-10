import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { TextInput } from 'react-native';

import { checkPin, notePinTry, resetPinTriesForTests, setPin } from '@/lib/profile-pin';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { mountWithPortal } from '@/testing/render-overlay';

import { PinDialog } from './pin-dialog';

beforeEach(async () => {
  await AsyncStorage.clear();
  resetProfilesForTests();
  resetPinTriesForTests();
  useProfiles.setState({
    hydrated: true,
    profiles: [{ id: 'sam', name: 'Sam', connectionIds: ['a.2'] }],
    activeProfileId: 'sam',
  });
});

/** checkPin / setPin are async (10,000 hash rounds, in chunks with a yield between): let
 * them land. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function type(value: string) {
  await fireEvent.changeText(screen.getByTestId('pin-field'), value);
  await settle();
}

describe('PinDialog, check', () => {
  const onDone = jest.fn();
  const onCancel = jest.fn();
  beforeEach(async () => {
    onDone.mockClear();
    await setPin('sam', '4821');
    await mountWithPortal(
      <PinDialog
        open
        mode="check"
        profileId="sam"
        name="Sam"
        onDone={onDone}
        onCancel={onCancel}
      />,
    );
  });

  it('asks for the PIN by name, with a labelled field and the way out of a forgotten one', () => {
    expect(screen.getByText("Enter Sam's PIN")).toBeTruthy();
    expect(screen.getByLabelText('PIN for Sam')).toBeTruthy();
    expect(screen.getByText(/Remove Sam from this device in Settings/)).toBeTruthy();
  });

  it('says a wrong PIN does not match, and clears the field', async () => {
    await type('1111');
    expect(screen.getByText("That PIN doesn't match")).toBeTruthy();
    expect(screen.getByTestId('pin-field').props.value).toBe('');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keeps the field (and the keyboard) through a check and after a wrong PIN', async () => {
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1111');
    // Checking: still editable (a non-editable field blurs on native and drops the sheet).
    expect(screen.getByTestId('pin-field').props.editable).not.toBe(false);
    await settle();
    expect(screen.getByText("That PIN doesn't match")).toBeTruthy();
    expect(screen.getByTestId('pin-field').props.value).toBe('');
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });

  it('ignores letters and submits at four digits', async () => {
    await type('48a21');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('makes the fifth wrong try wait 30 seconds, with the field off', async () => {
    for (let i = 0; i < 5; i++) await type('0000');
    expect(screen.getByText('Too many tries. Try again in 30 seconds.')).toBeTruthy();
    expect(screen.getByTestId('pin-field').props.editable).toBe(false);
    // Even the right PIN does nothing while it waits.
    await type('4821');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('cancels', async () => {
    await fireEvent.press(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('PinDialog, a lockout outlives the prompt', () => {
  it('a reopened prompt still waits', async () => {
    await setPin('sam', '4821');
    for (let i = 0; i < 5; i++) notePinTry('sam', false);
    await mountWithPortal(
      <PinDialog
        open
        mode="check"
        profileId="sam"
        name="Sam"
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Too many tries/)).toBeTruthy();
    expect(screen.getByTestId('pin-field').props.editable).toBe(false);
  });
});

describe('PinDialog, set', () => {
  it('asks twice and saves a matching PIN', async () => {
    const onDone = jest.fn();
    await mountWithPortal(
      <PinDialog open mode="set" profileId="sam" name="Sam" onDone={onDone} onCancel={() => {}} />,
    );
    expect(screen.getByText('Choose a 4-digit PIN')).toBeTruthy();
    await type('1357');
    expect(screen.getByText('Enter the PIN again')).toBeTruthy();
    await type('1357');
    expect(onDone).toHaveBeenCalled();
    expect(await checkPin('sam', '1357')).toBe(true);
    expect(useProfiles.getState().profiles[0].hasPin).toBe(true);
  });

  it('starts again when the two entries differ', async () => {
    const onDone = jest.fn();
    await mountWithPortal(
      <PinDialog open mode="set" profileId="sam" name="Sam" onDone={onDone} onCancel={() => {}} />,
    );
    await type('1357');
    await type('1358');
    expect(screen.getByText("Those PINs don't match. Choose one again.")).toBeTruthy();
    expect(screen.getByText('Choose a 4-digit PIN')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
