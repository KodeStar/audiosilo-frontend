import { render, screen, waitFor } from '@testing-library/react-native';

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
jest.mock('@/lib/device', () => ({ getDeviceName: () => 'Test browser' }));
jest.mock('@/components/shell/leave-onboarding', () => ({
  leaveOnboarding: jest.fn(),
  LeaveOnboarding: () => null,
}));

/* eslint-disable import/first */
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
});
