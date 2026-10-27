import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DemoSession } from '@/api/types';
import { useSession } from '@/stores/session';

const mockDemoSession = jest.fn();
jest.mock('@/api/client', () => {
  const actual = jest.requireActual('@/api/client');
  return {
    ...actual,
    ApiClient: jest.fn().mockImplementation(() => ({ demoSession: mockDemoSession })),
  };
});
jest.mock('@/lib/base-url', () => ({ webOrigin: () => 'http://127.0.0.1:8890' }));
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ router: { replace: (h: unknown) => mockReplace(h) } }));
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test browser' }));
jest.mock('@/components/shell/leave-onboarding', () => ({
  leaveOnboarding: jest.fn(),
  LeaveOnboarding: () => null,
}));

/* eslint-disable import/first */
import { ApiError } from '@/api/client';
import DemoScreen from '@/app/demo';
/* eslint-enable import/first */

const demo = (serverName: string): DemoSession =>
  ({
    token: 'tok',
    server_id: 'srv-demo',
    user: { id: 7, username: 'demo_cb805a73d8a4', role: 'user', disabled: false },
    pairing: {
      server_name: serverName,
      base_url: 'http://127.0.0.1:8890',
      pairing_token: 'p',
      uri: 'audiosilo://connect',
      web_url: 'http://127.0.0.1:8890/web/connect?token=p',
      qr_png_data_uri: 'data:image/png;base64,',
      links: { web: '', admin: '' },
    },
  }) as DemoSession;

describe('/demo', () => {
  let setSession: jest.Mock;
  beforeEach(() => {
    setSession = jest.fn(async () => 'c1');
    useSession.setState({ status: 'unauthenticated', connections: [], setSession } as never);
  });

  it("names the demo connection by the server's name, not its address", async () => {
    // The device pass: the top bar, profile menu, stats header and Year card all said
    // "127.0.0.1:8890" for the demo connection.
    mockDemoSession.mockResolvedValueOnce(demo('AudioSilo demo'));
    await render(<DemoScreen />);
    await waitFor(() => expect(setSession).toHaveBeenCalledTimes(1));
    expect(setSession).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'http://127.0.0.1:8890', name: 'AudioSilo demo' }),
    );
    // The QR stays on screen: the demo keeps its own flow.
    expect(await screen.findByLabelText(/QR/i)).toBeTruthy();
  });

  it('leaves the name to the session when the server sends none', async () => {
    mockDemoSession.mockResolvedValueOnce(demo(''));
    await render(<DemoScreen />);
    await waitFor(() => expect(setSession).toHaveBeenCalledTimes(1));
    expect(setSession.mock.calls[0][0]).not.toHaveProperty('name');
  });

  // CONNECT-11: a server without demo mode answers 404; Try again can never work.
  it('says a server without demo mode has no demo, and offers Sign in', async () => {
    mockDemoSession.mockRejectedValueOnce(new ApiError(404, 'demo mode is not enabled'));
    await render(<DemoScreen />);
    expect(await screen.findByText('This server has no demo')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.queryByText(/A live, read-only demo/)).toBeNull();
    await fireEvent.press(screen.getByText('Sign in'));
    expect(mockReplace).toHaveBeenCalledWith('/connect');
  });

  it('keeps Try again for a demo server that failed', async () => {
    mockDemoSession.mockRejectedValueOnce(new ApiError(429, 'too many demo sessions'));
    await render(<DemoScreen />);
    expect(await screen.findByText('Try again')).toBeTruthy();
    expect(screen.queryByText('This server has no demo')).toBeNull();
  });
});
