import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ConnectReveal, RevealViewContext } from './connect-frame';

describe('ConnectReveal', () => {
  it('asks the frame to scroll it into view once it is laid out', async () => {
    jest.useFakeTimers();
    try {
      const revealView = jest.fn();
      await render(
        <RevealViewContext.Provider value={revealView}>
          <ConnectReveal testID="reveal">
            <Text>Found Hearthside</Text>
          </ConnectReveal>
        </RevealViewContext.Provider>,
      );
      await fireEvent(screen.getByTestId('reveal'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 400, width: 360, height: 120 } },
      });
      // On the next frame, with the view's own handle.
      expect(revealView).not.toHaveBeenCalled();
      await act(async () => {
        jest.runOnlyPendingTimers();
      });
      expect(revealView).toHaveBeenCalledTimes(1);
      expect(revealView.mock.calls[0][0]).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
