import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import GoogleCast, { CastState } from 'react-native-google-cast';

import type { CastButtonModel } from './cast-button-model';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockModel: CastButtonModel = { show: true, blocked: null, status: 'off', deviceName: null };
jest.mock('./use-cast-button', () => ({ useCastButton: () => mockModel }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
const mockRequest = jest.fn(async () => {});
const mockReady = jest.fn(async () => true);
jest.mock('./cast-state', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useCast: create(() => ({ supported: true, status: 'off', deviceName: null })),
    requestCastSession: () => mockRequest(),
    ensureCastReady: () => mockReady(),
  };
});

/* eslint-disable import/first */
import { CastButton as NativeCastButton } from './cast-button.native';
import { useCast } from './cast-state';
import { CastButton as WebCastButton } from './cast-button.web';
/* eslint-enable import/first */

beforeEach(async () => {
  await cleanup();
  jest.clearAllMocks();
  mockModel = { show: true, blocked: null, status: 'off', deviceName: null };
  useCast.setState({ supported: true });
});

describe('the web Cast button', () => {
  it('loads the sender when it first shows, and opens the Cast chooser on press', async () => {
    await render(<WebCastButton testID="cast" />);
    expect(mockReady).toHaveBeenCalledTimes(1);
    const button = screen.getByLabelText('Cast');
    await fireEvent.press(button);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('says where it is casting', async () => {
    mockModel = { ...mockModel, status: 'connected', deviceName: 'Living room' };
    await render(<WebCastButton />);
    expect(screen.getByLabelText('Casting to Living room')).toBeTruthy();
  });

  it('explains instead of casting a book it cannot, and loads no sender for it', async () => {
    mockModel = { ...mockModel, blocked: 'local-address' };
    await render(<WebCastButton />);
    expect(mockReady).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Cast, not available for this book'));
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This book can't be cast" }),
    );
  });

  it('renders nothing (and loads nothing) where it is not shown', async () => {
    mockModel = { ...mockModel, show: false };
    await render(<WebCastButton testID="cast" />);
    expect(screen.queryByTestId('cast')).toBeNull();
    expect(mockReady).not.toHaveBeenCalled();
    await act(() => useCast.setState({ supported: false }));
    mockModel = { ...mockModel, show: true };
    await render(<WebCastButton testID="cast" />);
    expect(screen.queryByTestId('cast')).toBeNull();
  });
});

describe('the native Cast button', () => {
  it("is the SDK's own button, labelled, in a 44 pt frame", async () => {
    await render(<NativeCastButton testID="cast" compact />);
    const sdk = screen.getByTestId('sdk-cast-button');
    expect(sdk.props.accessibilityLabel).toBe('Cast');
    expect(screen.getByTestId('cast').props.style).toMatchObject({ width: 44, height: 44 });
  });

  it('is our explaining button for a book it cannot cast', async () => {
    mockModel = { ...mockModel, blocked: 'codec' };
    await render(<NativeCastButton />);
    expect(screen.queryByTestId('sdk-cast-button')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Cast, not available for this book'));
    expect(mockToast).toHaveBeenCalled();
  });

  describe('with no Cast device found (the SDK hides its button)', () => {
    const os = Platform.OS;
    let changed: (state: CastState) => void = () => undefined;
    let running = true;
    beforeEach(() => {
      jest.spyOn(GoogleCast, 'getCastState').mockResolvedValue(CastState.NO_DEVICES_AVAILABLE);
      jest.spyOn(GoogleCast, 'onCastStateChanged').mockImplementation((l) => {
        changed = l;
        return { remove() {} };
      });
      jest
        .spyOn(GoogleCast.getDiscoveryManager(), 'isRunning')
        .mockImplementation(async () => running);
    });
    afterEach(() => {
      Platform.OS = os;
      running = true;
      jest.restoreAllMocks();
    });

    it('leaves no empty slot, and comes back when a device is found', async () => {
      Platform.OS = 'android';
      await render(<NativeCastButton testID="cast" />);
      await act(async () => {});
      expect(screen.queryByTestId('cast')).toBeNull();
      await act(async () => changed(CastState.NOT_CONNECTED));
      expect(screen.getByTestId('sdk-cast-button')).toBeTruthy();
    });

    it('stays on iOS until discovery runs (its first tap starts it), then goes', async () => {
      Platform.OS = 'ios';
      running = false;
      jest.useFakeTimers();
      try {
        await render(<NativeCastButton testID="cast" />);
        await act(async () => {});
        expect(screen.getByTestId('sdk-cast-button')).toBeTruthy();
        // Tapped: discovery runs and finds nothing (no event says so: asked again).
        running = true;
        await act(() => jest.advanceTimersByTimeAsync(2_000));
        expect(screen.queryByTestId('cast')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('still explains a book it cannot cast', async () => {
      Platform.OS = 'android';
      mockModel = { ...mockModel, blocked: 'codec' };
      await render(<NativeCastButton />);
      await act(async () => {});
      expect(screen.getByLabelText('Cast, not available for this book')).toBeTruthy();
    });
  });

  it('is absent on a binary or device that cannot cast', async () => {
    useCast.setState({ supported: false });
    await render(<NativeCastButton testID="cast" />);
    expect(screen.queryByTestId('sdk-cast-button')).toBeNull();
  });
});
