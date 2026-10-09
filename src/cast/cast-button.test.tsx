import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';

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

  it('explains instead of casting a book it cannot', async () => {
    mockModel = { ...mockModel, blocked: 'local-address' };
    await render(<WebCastButton />);
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

  it('is absent on a binary or device that cannot cast', async () => {
    useCast.setState({ supported: false });
    await render(<NativeCastButton testID="cast" />);
    expect(screen.queryByTestId('sdk-cast-button')).toBeNull();
  });
});
