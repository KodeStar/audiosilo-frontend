import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Dimensions, Keyboard, type KeyboardEvent, Platform, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { mountWithPortal } from '@/testing/render-overlay';

import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  useDialogFrame,
} from './dialog';

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <DialogTrigger accessibilityLabel="Open">
        <Text>Open</Text>
      </DialogTrigger>
      <DialogContent testID="rename-dialog">
        <DialogTitle>Rename</DialogTitle>
        <DialogDescription>Give the shelf a name.</DialogDescription>
        <Button title="Save" onPress={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('opens from its trigger into the portal, as a dialog with a title', async () => {
    await mountWithPortal(<Harness />);
    expect(screen.queryByText('Rename')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Open'));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Give the shelf a name.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rename' })).toBeTruthy();
    // The card carries role="dialog" + aria-modal (a container, so not an a11y leaf).
    expect(screen.getByTestId('rename-dialog')).toHaveProp('role', 'dialog');
    expect(screen.getByTestId('rename-dialog')).toHaveProp('aria-modal', true);
  });

  it('closes from its translated close button', async () => {
    const onOpenChange = jest.fn();
    await mountWithPortal(<Harness onOpenChange={onOpenChange} />);
    await fireEvent.press(screen.getByLabelText('Open'));

    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('Rename')).toBeNull();
  });
});

describe('useDialogFrame', () => {
  const prevOS = Platform.OS;
  afterEach(async () => {
    Platform.OS = prevOS;
    await act(async () => {
      Dimensions.set({ window: { width: 750, height: 1334, scale: 2, fontScale: 1 } });
    });
  });

  async function frameAt(width: number) {
    const { result } = await renderHook(() => useDialogFrame(), {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width, height: 800 },
            insets: { top: 0, left: 0, right: 0, bottom: 34 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    });
    return result.current;
  }

  it('gives the web dialog a definite width, not a shrink-wrapped one (0a spike)', async () => {
    Platform.OS = 'web';
    await act(async () => {
      Dimensions.set({ window: { width: 1440, height: 900, scale: 1, fontScale: 1 } });
    });
    const frame = await frameAt(1440);
    expect(frame.compact).toBe(false);
    expect(frame.contentClassName).toContain('w-[min(520px,calc(100vw-2rem))]');
    expect(frame.contentClassName).toContain('rounded-dialog');
  });

  it('presents as a bottom sheet on a phone, clear of the home indicator', async () => {
    await act(async () => {
      Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 } });
    });
    const frame = await frameAt(390);
    expect(frame.compact).toBe(true);
    expect(frame.contentClassName).toContain('rounded-t-sheet');
    expect(frame.overlayClassName).toContain('justify-end');
    expect(frame.contentStyle).toEqual({ paddingBottom: 50 });
  });

  it('rises above the iOS keyboard on a phone and fits under the top edge', async () => {
    Platform.OS = 'ios';
    await act(async () => {
      Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 } });
    });
    const handlers: Record<string, (e: KeyboardEvent) => void> = {};
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((
      name: string,
      cb: (e: KeyboardEvent) => void,
    ) => {
      handlers[name] = cb;
      return { remove: jest.fn() };
    }) as never);
    try {
      const { result } = await renderHook(() => useDialogFrame(), {
        wrapper: ({ children }) => (
          <SafeAreaProvider
            initialMetrics={{
              frame: { x: 0, y: 0, width: 390, height: 844 },
              insets: { top: 47, left: 0, right: 0, bottom: 34 },
            }}
          >
            {children}
          </SafeAreaProvider>
        ),
      });
      await act(() =>
        handlers.keyboardWillShow({
          duration: 250,
          endCoordinates: { screenY: 844 - 336, height: 336, screenX: 0, width: 390 },
        } as KeyboardEvent),
      );
      expect(result.current.contentStyle).toEqual({
        paddingBottom: 50,
        marginBottom: 336 - 34,
        maxHeight: 844 - 336 - 47 - 8,
      });
    } finally {
      spy.mockRestore();
    }
  });
});
