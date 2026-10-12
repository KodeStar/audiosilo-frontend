import { Keyboard, Platform, TextInput } from 'react-native';

import { releaseKeyboard } from './keyboard-release';

describe('releaseKeyboard', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
    jest.restoreAllMocks();
  });

  it('blurs the focused field React Native knows of, then dismisses the keyboard', () => {
    const order: string[] = [];
    const field = {} as ReturnType<typeof TextInput.State.currentlyFocusedInput>;
    jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue(field);
    jest
      .spyOn(TextInput.State, 'blurTextInput')
      .mockImplementation((f) => void order.push(f === field ? 'blur:field' : 'blur:other'));
    jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => void order.push('dismiss'));
    releaseKeyboard();
    expect(order).toEqual(['blur:field', 'dismiss']);
  });

  it('only dismisses when no field is focused', () => {
    jest
      .spyOn(TextInput.State, 'currentlyFocusedInput')
      .mockReturnValue(null as unknown as ReturnType<typeof TextInput.State.currentlyFocusedInput>);
    const blur = jest.spyOn(TextInput.State, 'blurTextInput');
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    releaseKeyboard();
    expect(blur).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('does nothing on the web (the dialog returns focus itself)', () => {
    Platform.OS = 'web';
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    releaseKeyboard();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
