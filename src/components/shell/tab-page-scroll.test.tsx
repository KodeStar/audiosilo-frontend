import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

let mockInset = 16;
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => mockInset }));

/* eslint-disable import/first */
import { TabPageScroll } from './tab-page-scroll';
/* eslint-enable import/first */

const scroller = () => screen.getByTestId('page');

describe('TabPageScroll', () => {
  beforeEach(() => {
    mockInset = 16;
  });

  it('asks iOS for the tab bar inset itself and keeps taps while the keyboard is up', async () => {
    // A tab page scroller under the sections (the You hub, the Library modes) is never the
    // first ScrollView react-native-screens looks for, so without this its end scrolled
    // under the tab bar.
    await render(
      <TabPageScroll testID="page">
        <Text>row</Text>
      </TabPageScroll>,
    );
    expect(scroller().props.contentInsetAdjustmentBehavior).toBe('automatic');
    expect(scroller().props.keyboardShouldPersistTaps).toBe('handled');
  });

  it("clears the floating mini player, under the page's own content padding", async () => {
    mockInset = 112;
    await render(<TabPageScroll testID="page" contentContainerStyle={{ paddingTop: 20 }} />);
    const style = StyleSheet.flatten(scroller().props.contentContainerStyle);
    expect(style).toMatchObject({ paddingBottom: 112, paddingTop: 20 });
  });
});
