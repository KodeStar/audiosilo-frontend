import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import type { PairingPayload } from '@/api/types';

const mockPair = jest.fn();
jest.mock('@/api/provider', () => ({ useOptionalApi: () => ({ pair: mockPair }) }));
const mockCopy = jest.fn();
jest.mock('@/lib/clipboard', () => ({ copyText: (s: string) => mockCopy(s) }));
const mockShare = jest.fn();
jest.mock('@/lib/share', () => ({ shareText: (s: string) => mockShare(s) }));

/* eslint-disable import/first */
import { PairDeviceCard } from './pair-device-card';
/* eslint-enable import/first */

const payload: PairingPayload = {
  server_name: 'Hearthside',
  base_url: 'https://books.example',
  pairing_token: 'tok',
  uri: 'audiosilo://connect?server=https://books.example&token=tok',
  web_url: 'https://books.example/web/connect?token=tok',
  qr_png_data_uri: 'data:image/png;base64,AAAA',
  links: { web: 'https://books.example/web', admin: 'https://books.example/admin' },
};

const mount = () => render(<PairDeviceCard connectionId="c" serverName="Hearthside" />);

async function showCode() {
  await fireEvent.press(screen.getByRole('button', { name: 'Show a pairing code' }));
}

const OS = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks();
  mockPair.mockResolvedValue(payload);
  Platform.OS = OS;
});
afterEach(() => {
  jest.useRealTimers();
});
afterAll(() => {
  Platform.OS = OS;
});

describe('PairDeviceCard', () => {
  it('makes a code on request and counts its 10 minutes down', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-08T12:00:00Z') });
    await mount();
    expect(mockPair).not.toHaveBeenCalled();
    await showCode();
    expect(mockPair).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('image', { name: 'Pairing code for Hearthside' })).toBeTruthy();
    expect(screen.getByTestId('pair-countdown')).toHaveTextContent('Expires in 10:00');

    await act(async () => {
      jest.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId('pair-countdown')).toHaveTextContent('Expires in 8:59');
  });

  it('offers a new code once it has expired', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-08T12:00:00Z') });
    await mount();
    await showCode();
    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.queryByTestId('pair-countdown')).toBeNull();
    expect(
      screen.getByText('This code has expired. Make a new one to pair a device.'),
    ).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Make a new code' }));
    expect(mockPair).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('pair-countdown')).toHaveTextContent('Expires in 10:00');
  });

  it('copies the link on the web and confirms it', async () => {
    Platform.OS = 'web';
    mockCopy.mockResolvedValue(true);
    await mount();
    await showCode();
    await fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(mockCopy).toHaveBeenCalledWith(payload.web_url);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('shares the link through the share sheet on iOS and Android', async () => {
    Platform.OS = 'android';
    await mount();
    await showCode();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Share link' }));
    expect(mockShare).toHaveBeenCalledWith(payload.web_url);
  });

  it('puts the code away with Done', async () => {
    await mount();
    await showCode();
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('image')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show a pairing code' })).toBeTruthy();
  });

  it('says the server could not be reached and nothing was made', async () => {
    mockPair.mockRejectedValue(new TypeError('Network request failed'));
    await mount();
    await showCode();
    expect(
      screen.getByText("Couldn't reach Hearthside. No code was made, so try again."),
    ).toBeTruthy();
    expect(screen.queryByRole('image')).toBeNull();
  });

  it("shows the server's own reason when it refuses", async () => {
    mockPair.mockRejectedValue(new ApiError(403, 'API keys cannot pair devices'));
    await mount();
    await showCode();
    expect(screen.getByText('API keys cannot pair devices')).toBeTruthy();
  });
});
