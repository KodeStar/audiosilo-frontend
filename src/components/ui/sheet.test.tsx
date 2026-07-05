import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Platform, Text } from 'react-native';

// Zero insets so the sheet doesn't depend on a SafeAreaProvider in the test tree.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// Mock the theme hook so the primitive doesn't need a ThemeProvider (whose module
// also side-effect-imports global.css, unparseable in the Node test runtime).
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { Sheet } from './sheet';
/* eslint-enable import/first */

async function mount(ui: React.ReactElement) {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
  });
  return result;
}

describe('Sheet', () => {
  it('renders children while visible and closes on backdrop press', async () => {
    const onClose = jest.fn();
    await mount(
      <Sheet visible onClose={onClose}>
        <Text>Sheet body</Text>
      </Sheet>,
    );

    expect(screen.getByText('Sheet body')).toBeTruthy();
    // With no title there is a single "Close" affordance: the backdrop.
    fireEvent.press(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via the header close button when a title is set', async () => {
    const onClose = jest.fn();
    await mount(
      <Sheet visible onClose={onClose} title="Chapters">
        <Text>Sheet body</Text>
      </Sheet>,
    );

    expect(screen.getByText('Chapters')).toBeTruthy();
    // Backdrop + header button both labelled Close.
    const closers = screen.getAllByLabelText('Close');
    expect(closers.length).toBe(2);
    fireEvent.press(closers[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('unmounts children after the exit animation completes', async () => {
    const onClose = jest.fn();
    const { rerender } = await mount(
      <Sheet visible onClose={onClose}>
        <Text>Sheet body</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Sheet body')).toBeTruthy();

    await act(async () => {
      rerender(
        <Sheet visible={false} onClose={onClose}>
          <Text>Sheet body</Text>
        </Sheet>,
      );
    });
    // The mocked timing invokes its completion callback synchronously.
    expect(screen.queryByText('Sheet body')).toBeNull();
  });

  it('presents inside an RN Modal by default and routes hardware-back via onRequestClose', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'android';
    const addSpy = jest.spyOn(BackHandler, 'addEventListener');
    const onClose = jest.fn();

    try {
      await mount(
        <Sheet visible onClose={onClose}>
          <Text>Sheet body</Text>
        </Sheet>,
      );

      // Default (Modal) mode hosts the overlay in a visible transparent Modal (the
      // Sheet's root node).
      const modal = screen.root;
      expect(modal?.type).toBe('Modal');
      expect(modal?.props.transparent).toBe(true);
      expect(modal?.props.visible).toBe(true);
      expect(screen.getByText('Sheet body')).toBeTruthy();
      // ...and must NOT register the manual BackHandler (the Modal swallows the key
      // and delivers it through onRequestClose instead, so we'd otherwise double-fire).
      expect(addSpy).not.toHaveBeenCalled();
      // Hardware-back is wired to our close handler via the Modal's onRequestClose.
      expect(modal?.props.onRequestClose).toBe(onClose);
    } finally {
      addSpy.mockRestore();
      Platform.OS = prevOS;
    }
  });

  it('inline mode renders the overlay directly and closes on backdrop press', async () => {
    const onClose = jest.fn();
    await mount(
      <Sheet inline visible onClose={onClose}>
        <Text>Sheet body</Text>
      </Sheet>,
    );

    // Inline mode does not use a Modal (it must present inside the iOS player modal).
    expect(screen.root?.type).not.toBe('Modal');
    expect(screen.getByText('Sheet body')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('inline mode registers an Android hardware-back handler that closes it, and cleans up', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'android';
    const removeSub = jest.fn();
    const addSpy = jest
      .spyOn(BackHandler, 'addEventListener')
      .mockReturnValue({ remove: removeSub } as unknown as ReturnType<
        typeof BackHandler.addEventListener
      >);
    const onClose = jest.fn();

    try {
      const { rerender } = await mount(
        <Sheet inline visible onClose={onClose}>
          <Text>Sheet body</Text>
        </Sheet>,
      );

      expect(addSpy).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
      const handler = addSpy.mock.calls[0][1] as () => boolean;
      expect(handler()).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);

      // Hiding the sheet tears the handler down.
      await act(async () => {
        rerender(
          <Sheet inline visible={false} onClose={onClose}>
            <Text>Sheet body</Text>
          </Sheet>,
        );
      });
      expect(removeSub).toHaveBeenCalled();
    } finally {
      addSpy.mockRestore();
      Platform.OS = prevOS;
    }
  });

  it('renders nothing when not visible', async () => {
    await mount(
      <Sheet visible={false} onClose={jest.fn()}>
        <Text>Sheet body</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Sheet body')).toBeNull();
  });
});
