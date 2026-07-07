import { act, render, screen } from '@testing-library/react-native';
import { BackHandler, Platform, Text } from 'react-native';

import { OverlayHost } from './overlay-host';

async function mount(ui: React.ReactElement) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result;
}

describe('OverlayHost', () => {
  it('renders its children in place when visible, and nothing when hidden', async () => {
    const { rerender } = await mount(
      <OverlayHost visible onRequestClose={jest.fn()}>
        <Text>Overlay body</Text>
      </OverlayHost>,
    );

    expect(screen.getByText('Overlay body')).toBeTruthy();

    await act(async () => {
      rerender(
        <OverlayHost visible={false} onRequestClose={jest.fn()}>
          <Text>Overlay body</Text>
        </OverlayHost>,
      );
    });
    expect(screen.queryByText('Overlay body')).toBeNull();
  });

  it('renders nothing when not visible', async () => {
    await mount(
      <OverlayHost visible={false} onRequestClose={jest.fn()}>
        <Text>Overlay body</Text>
      </OverlayHost>,
    );
    expect(screen.queryByText('Overlay body')).toBeNull();
  });

  it('registers an Android hardware-back handler that closes it while visible, and cleans up on hide', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'android';
    const removeSub = jest.fn();
    const addSpy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockReturnValue({ remove: removeSub } as unknown as ReturnType<
        typeof BackHandler.addEventListener
      >);
    const onRequestClose = jest.fn();

    try {
      const { rerender } = await mount(
        <OverlayHost visible onRequestClose={onRequestClose}>
          <Text>Overlay body</Text>
        </OverlayHost>,
      );

      expect(addSpy).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
      const handler = addSpy.mock.calls[0][1] as () => boolean;
      expect(handler()).toBe(true);
      expect(onRequestClose).toHaveBeenCalledTimes(1);

      // Hiding tears the handler down.
      await act(async () => {
        rerender(
          <OverlayHost visible={false} onRequestClose={onRequestClose}>
            <Text>Overlay body</Text>
          </OverlayHost>,
        );
      });
      expect(removeSub).toHaveBeenCalled();
    } finally {
      addSpy.mockRestore();
      Platform.OS = prevOS;
    }
  });
});
