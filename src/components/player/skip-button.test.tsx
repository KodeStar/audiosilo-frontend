import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { setFontScale } from '@/testing/font-scale';

import { SKIP_LABEL_MAX_SCALE, SkipButton } from './skip-button';

const fontSize = () => StyleSheet.flatten(screen.getByText('-15s').props.style).fontSize;

describe('SkipButton', () => {
  afterEach(async () => {
    await setFontScale(1);
  });

  it('grows its label with the text size, up to its cap', async () => {
    await render(
      <SkipButton
        direction="back"
        seconds={15}
        onPress={jest.fn()}
        color="#000"
        accessibilityLabel="Back 15 seconds"
      />,
    );
    expect(fontSize()).toBe(13);
    await setFontScale(1.2);
    expect(fontSize()).toBe(16);
    await setFontScale(3);
    expect(fontSize()).toBe(Math.round(13 * SKIP_LABEL_MAX_SCALE));
    // Never wrapped ("-15 / s" in the mini player at Android's 2.0): one line, and the
    // caller's box grows to it.
    expect(screen.getByText('-15s').props.numberOfLines).toBe(1);
  });

  it('keeps a size its caller already scaled', async () => {
    await setFontScale(2);
    await render(
      <SkipButton
        direction="back"
        seconds={15}
        onPress={jest.fn()}
        color="#000"
        fontSize={22}
        maxFontScale={1}
        accessibilityLabel="Back 15 seconds"
      />,
    );
    expect(fontSize()).toBe(22);
  });
});
