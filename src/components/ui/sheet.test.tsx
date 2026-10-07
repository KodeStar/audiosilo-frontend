import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { BackHandler, Platform, Text } from 'react-native';

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
