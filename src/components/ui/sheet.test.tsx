import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Keyboard, Platform, Text, TextInput } from 'react-native';

// Zero insets so the sheet doesn't depend on a SafeAreaProvider in the test tree.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
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
  it('floats a hosted sheet at 560 on a tablet and scrolls a long body', async () => {
    mockLayout = 'tablet';
    await mount(
      <Sheet visible onClose={jest.fn()} scroll>
        <Text>Sheet body</Text>
      </Sheet>,
    );
    expect(screen.getByText('Sheet body')).toBeTruthy();
    const json = JSON.stringify(screen.toJSON());
    expect(json).toContain('"maxWidth":560');
    expect(json).toContain('RCTScrollView');
    mockLayout = 'phone';
  });

  it('is a modal layer on the web (the player shortcuts stand back)', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'web';
    try {
      await mount(
        <Sheet visible onClose={jest.fn()}>
          <Text>Hosted</Text>
        </Sheet>,
      );
      const json = JSON.stringify(screen.toJSON());
      expect(json.match(/"aria-modal":true/g)).toHaveLength(1);
      expect(json).toContain('"role":"dialog"');
      expect(json).not.toContain('"dataSet"');
    } finally {
      Platform.OS = prevOS;
    }
  });

  it('names its layer on the web, for the shortcut that toggles it', async () => {
    const prevOS = Platform.OS;
    Platform.OS = 'web';
    try {
      await mount(
        <Sheet visible onClose={jest.fn()} layer="upnext">
          <Text>Hosted</Text>
        </Sheet>,
      );
      expect(JSON.stringify(screen.toJSON())).toContain('"dataSet":{"layer":"upnext"}');
    } finally {
      Platform.OS = prevOS;
    }
  });

  it('gives a fill body a definite height to measure its own scroller against', async () => {
    await mount(
      <Sheet visible onClose={jest.fn()} fill maxHeightFraction={0.5}>
        <Text>List</Text>
      </Sheet>,
    );
    const json = JSON.stringify(screen.toJSON());
    // Half the (1334 tall) test window, as a height rather than a cap.
    expect(json).toContain('"height":667');
    expect(json).not.toContain('"maxHeight"');
    expect(json).not.toContain('RCTScrollView');
  });

  it('renders children while visible and closes on backdrop press', async () => {
    const onClose = jest.fn();
    await mount(
      <Sheet visible onClose={onClose}>
        <Text>Sheet body</Text>
      </Sheet>,
    );

    expect(screen.getByText('Sheet body')).toBeTruthy();
    // A tap outside closes (the backdrop is out of the accessibility tree: by test ID).
    fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
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
    // The header's button is the one Close a screen reader finds.
    const closers = screen.getAllByRole('button', { name: 'Close' });
    expect(closers.length).toBe(1);
    fireEvent.press(closers[0]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('modal to a screen reader (fe#267)', () => {
    it('keeps VoiceOver to the layer, closes on its escape gesture, and titles it as a heading', async () => {
      const onClose = jest.fn();
      await mount(
        <Sheet visible onClose={onClose} title="Speed">
          <Text>Sheet body</Text>
        </Sheet>,
      );
      // The layer: the sheet body's nearest ancestor flagged modal.
      let layer = screen.getByText('Sheet body').parent;
      while (layer && !layer.props.accessibilityViewIsModal) layer = layer.parent;
      expect(layer).toBeTruthy();
      layer!.props.onAccessibilityEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('header', { name: 'Speed' })).toHaveProp('aria-level', 2);
    });

    it('leaves the backdrop out of the accessibility tree and the tab order', async () => {
      await mount(
        <Sheet visible onClose={jest.fn()} title="Speed">
          <Text>Sheet body</Text>
        </Sheet>,
      );
      const backdrop = screen.getByTestId('sheet-backdrop', { includeHiddenElements: true });
      expect(backdrop.props.accessible).toBe(false);
      expect(backdrop.props.accessibilityRole).toBeUndefined();
      expect(backdrop.props.accessibilityLabel).toBeUndefined();
      expect(backdrop).toHaveProp('importantForAccessibility', 'no-hide-descendants');
      expect(backdrop).toHaveProp('focusable', false);
    });

    it('counts as an open modal layer while visible, so the page behind hides', async () => {
      const { useModalLayerOpen } = jest.requireActual(
        './modal-layer',
      ) as typeof import('./modal-layer');
      const seen: boolean[] = [];
      function Page() {
        seen.push(useModalLayerOpen());
        return null;
      }
      const view = await mount(
        <>
          <Page />
          <Sheet visible onClose={jest.fn()} title="Speed">
            <Text>Sheet body</Text>
          </Sheet>
        </>,
      );
      expect(seen.at(-1)).toBe(true);
      await act(async () => {
        view.rerender(
          <>
            <Page />
            <Sheet visible={false} onClose={jest.fn()} title="Speed">
              <Text>Sheet body</Text>
            </Sheet>
          </>,
        );
      });
      expect(seen.at(-1)).toBe(false);
    });

    it('is a dialog named by its title on the web', async () => {
      const prevOS = Platform.OS;
      Platform.OS = 'web';
      try {
        await mount(
          <Sheet visible onClose={jest.fn()} title="Sleep timer">
            <Text>Hosted</Text>
          </Sheet>,
        );
        const json = JSON.stringify(screen.toJSON());
        expect(json).toContain('"aria-label":"Sleep timer"');
        expect(json).not.toContain('accessibilityViewIsModal');
      } finally {
        Platform.OS = prevOS;
      }
    });
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

  it('releases the keyboard while a focused field is still on screen, however it closes', async () => {
    const order: string[] = [];
    const spy = jest
      .spyOn(Keyboard, 'dismiss')
      .mockImplementation(
        () => void order.push(screen.queryByTestId('note') ? 'dismiss:field' : 'dismiss:gone'),
      );
    const onClose = jest.fn(() => order.push('close'));
    const ui = (visible: boolean) => (
      <Sheet visible={visible} onClose={onClose}>
        <TextInput testID="note" autoFocus />
      </Sheet>
    );
    const { rerender } = await mount(ui(true));
    // The backdrop (and the close button, and back): before the caller closes.
    await fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(order).toEqual(['dismiss:field', 'close']);
    // The caller turning it off (a Save in the sheet): before the field goes.
    order.length = 0;
    await act(async () => {
      rerender(ui(false));
    });
    expect(order).toEqual(['dismiss:field']);
    expect(screen.queryByTestId('note')).toBeNull();
    spy.mockRestore();
  });

  it('presents through an OverlayHost (no RN Modal) and routes Android hardware-back to onClose', async () => {
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

      // There is no RN Modal anymore: the overlay is handed to an OverlayHost, which
      // renders it in place. Either way, no Modal host node.
      expect(screen.root?.type).not.toBe('Modal');
      expect(screen.getByText('Sheet body')).toBeTruthy();
      // The OverlayHost owns Android hardware-back (exactly one registration). Pressing it
      // closes.
      expect(addSpy).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
      const handler = addSpy.mock.calls[0][1] as () => boolean;
      expect(handler()).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
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

  it('mounts on open even when it started closed (open derives from the prop, not state)', async () => {
    // Starting closed must not flash-mount (the wasVisible guard), and a later open
    // must mount the content. The old render-phase mount machine could drop the
    // open under React 19 concurrent replays; opening now depends only on `visible`.
    const onClose = jest.fn();
    const { rerender } = await mount(
      <Sheet visible={false} onClose={onClose}>
        <Text>Sheet body</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Sheet body')).toBeNull();

    await act(async () => {
      rerender(
        <Sheet visible onClose={onClose}>
          <Text>Sheet body</Text>
        </Sheet>,
      );
    });
    expect(screen.getByText('Sheet body')).toBeTruthy();
  });
});
