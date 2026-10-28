import { act, render, screen } from '@testing-library/react-native';

import { useReachability } from '@/api/reachability';
import i18n from '@/i18n';
import { useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

let mockDeviceOnline = true;
jest.mock('@/lib/device-online', () => ({ useDeviceOnline: () => mockDeviceOnline }));

/* eslint-disable import/first */
import { OfflineBanner, offlineBannerText } from './offline-banner';
/* eslint-enable import/first */

const OFFLINE = 'Offline - changes sync when reconnected';
const SOME = 'Some servers offline';
const t = i18n.t.bind(i18n);

beforeEach(() => {
  mockDeviceOnline = true;
  useReachability.setState({ online: {} });
  useProfiles.setState({ profiles: [], activeProfileId: null });
  useSession.setState({
    connections: [
      { id: 'a', name: 'Hearthside' },
      { id: 'b', name: 'Attic' },
    ],
  } as never);
});

// CONNECT-15: with a network, the server that is down is named.
describe('OfflineBanner', () => {
  it("names the page's own server when it isn't answering", async () => {
    useReachability.setState({ online: { a: true, b: false } });
    await render(<OfflineBanner connectionId="a" />);
    expect(screen.queryByText(/isn't answering/)).toBeNull();
    await act(async () => useReachability.setState({ online: { a: false, b: false } }));
    expect(screen.getByText("Hearthside isn't answering")).toBeTruthy();
  });

  it('says the device is offline when it has no network', async () => {
    mockDeviceOnline = false;
    useReachability.setState({ online: { a: false } });
    await render(<OfflineBanner connectionId="a" />);
    expect(screen.getByText(OFFLINE)).toBeTruthy();
  });

  it('names the one server down on an aggregated page, never "some servers"', async () => {
    await render(<OfflineBanner />);
    expect(screen.queryByText(/isn't answering/)).toBeNull();
    await act(async () => useReachability.setState({ online: { b: false } }));
    expect(screen.getByText("Attic isn't answering")).toBeTruthy();
    expect(screen.queryByText(SOME)).toBeNull();
  });

  it('says some servers are offline when more than one is down', async () => {
    useReachability.setState({ online: { a: false, b: false } });
    await render(<OfflineBanner />);
    expect(screen.getByText(SOME)).toBeTruthy();
  });

  it("never names another person's server on an aggregated page", async () => {
    useProfiles.setState({
      profiles: [
        { id: 'p1', connectionIds: ['a'] },
        { id: 'p2', connectionIds: ['b'] },
      ],
      activeProfileId: 'p1',
    } as never);
    useReachability.setState({ online: { b: false } });
    await render(<OfflineBanner />);
    expect(screen.queryByText(/Attic/)).toBeNull();
  });

  it("says offline for a scoped page's server it has no name for", async () => {
    useReachability.setState({ online: { z: false } });
    await render(<OfflineBanner connectionId="z" />);
    expect(screen.getByText(OFFLINE)).toBeTruthy();
  });
});

describe('offlineBannerText', () => {
  it('is nothing with no server down', () => {
    expect(offlineBannerText([], true, t)).toBeNull();
    expect(offlineBannerText([], false, t)).toBeNull();
  });

  it('blames the device only when it has no network', () => {
    expect(offlineBannerText(['A', 'B'], false, t)).toBe(OFFLINE);
    expect(offlineBannerText(['A'], true, t)).toBe("A isn't answering");
    expect(offlineBannerText(['A', 'B'], true, t)).toBe(SOME);
  });
});
