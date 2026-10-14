import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Keyboard, TextInput } from 'react-native';

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

/** Records, in order, the keyboard going (`Keyboard.dismiss`, with whether the PIN field
 * was still on screen then), the field's focus, and the caller's callbacks. */
function trackKeyboard() {
  const order: string[] = [];
  const spies = [
    jest
      .spyOn(Keyboard, 'dismiss')
      .mockImplementation(
        () => void order.push(screen.queryByTestId('pin-field') ? 'dismiss:field' : 'dismiss:gone'),
      ),
    jest.spyOn(TextInput.prototype, 'focus').mockImplementation(() => void order.push('focus')),
  ];
  return { order, restore: () => spies.forEach((s) => s.mockRestore()) };
}

/** The prompt as its callers use it: closed by its own `onDone` / `onCancel`. */
function ClosingPin({
  mode,
  onDone,
  onCancel,
}: {
  mode: 'check' | 'set';
  onDone: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <PinDialog
      open={open}
      mode={mode}
      profileId="sam"
      name="Sam"
      onDone={() => {
        onDone();
        setOpen(false);
      }}
      onCancel={() => {
        onCancel();
        setOpen(false);
      }}
    />
  );
}

async function type(value: string) {
  await fireEvent.changeText(screen.getByTestId('pin-field'), value);
  await settle();
}

describe('PinDialog, check', () => {
  const onDone = jest.fn();
  const onCancel = jest.fn();
  beforeEach(async () => {
    onDone.mockReset();
    onCancel.mockReset();
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
    expect(screen.getByText(/Remove Sam from this device on the Household page/)).toBeTruthy();
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

  it('a wrong PIN still being checked when Cancel is pressed does not refocus', async () => {
    const kb = trackKeyboard();
    await fireEvent.changeText(screen.getByTestId('pin-field'), '1111');
    await fireEvent.press(screen.getByText('Cancel'));
    await settle();
    expect(kb.order).not.toContain('focus');
    expect(screen.queryByText("That PIN doesn't match")).toBeNull();
    kb.restore();
  });

  it('the right PIN, still being checked when Cancel is pressed, does not switch', async () => {
    await fireEvent.changeText(screen.getByTestId('pin-field'), '4821');
    await fireEvent.press(screen.getByText('Cancel'));
    await settle();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
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

// Android (Pixel 6a): the field was removed with the number pad up and the keyboard
// stayed, as a full QWERTY one, over "Who's listening?" and then Home. The shared Dialog
// releases it while the field is still on screen, however the prompt closes.
describe('PinDialog, the keyboard on close', () => {
  it('a right PIN: released with the field still on screen, and nothing refocuses', async () => {
    const kb = trackKeyboard();
    const onDone = jest.fn(() => void kb.order.push('done'));
    await setPin('sam', '4821');
    await mountWithPortal(<ClosingPin mode="check" onDone={onDone} onCancel={() => {}} />);
    await type('4821');
    expect(kb.order).toEqual(['done', 'dismiss:field']);
    expect(screen.queryByTestId('pin-field')).toBeNull();
    kb.restore();
  });

  it('Cancel: released before the field goes', async () => {
    const kb = trackKeyboard();
    await setPin('sam', '4821');
    await mountWithPortal(<ClosingPin mode="check" onDone={() => {}} onCancel={() => {}} />);
    await fireEvent.press(screen.getByText('Cancel'));
    expect(kb.order).toEqual(['dismiss:field']);
    expect(screen.queryByTestId('pin-field')).toBeNull();
    kb.restore();
  });

  it('the close button: released before onCancel', async () => {
    const kb = trackKeyboard();
    await setPin('sam', '4821');
    await mountWithPortal(
      <ClosingPin mode="check" onDone={() => {}} onCancel={() => void kb.order.push('cancel')} />,
    );
    await fireEvent.press(screen.getByLabelText('Close'));
    expect(kb.order[0]).toBe('dismiss:field');
    expect(kb.order).toContain('cancel');
    expect(screen.queryByTestId('pin-field')).toBeNull();
    kb.restore();
  });

  it('a saved PIN: released with the field still on screen', async () => {
    const kb = trackKeyboard();
    await mountWithPortal(<ClosingPin mode="set" onDone={() => {}} onCancel={() => {}} />);
    await type('1357');
    await type('1357');
    expect(kb.order).toEqual(['dismiss:field']);
    expect(screen.queryByTestId('pin-field')).toBeNull();
    kb.restore();
  });
});
