import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { ConnectReveal, RevealKeepContext, RevealViewContext } from './connect-frame';

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

  it('stays kept in view with the field while it is shown', async () => {
    // Tapping the field again after the notice showed let the keyboard cover it (Pixel):
    // the frame's later reveals now include every shown ConnectReveal.
    const unkeep = jest.fn();
    const keep = jest.fn(() => unkeep);
    const view = await render(
      <RevealKeepContext.Provider value={keep}>
        <ConnectReveal testID="reveal">
          <Text>Found Hearthside</Text>
        </ConnectReveal>
      </RevealKeepContext.Provider>,
    );
    expect(keep).toHaveBeenCalledTimes(1);
    expect(keep.mock.calls[0]).toEqual([expect.anything()]);
    expect(unkeep).not.toHaveBeenCalled();
    await view.unmount();
    expect(unkeep).toHaveBeenCalledTimes(1);
  });
});
