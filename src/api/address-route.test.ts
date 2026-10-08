import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import {
  effectiveUrl,
  pickedUrl,
  setAddressPick,
  useActiveAddress,
  useAddressRoute,
} from '@/api/address-route';
import { useSession } from '@/stores/session';

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';
const conn = {
  id: 'srv-a',
  serverUrl: AWAY,
  name: 'Hearthside',
  token: 't',
  addresses: { home: HOME, away: AWAY },
};

const OS = Platform.OS;
afterEach(() => {
  Platform.OS = OS;
  useAddressRoute.setState({ picks: {} });
  useSession.setState({ connections: [] } as never);
});

describe('the pick store', () => {
  it('uses serverUrl until something is picked', () => {
    expect(effectiveUrl(conn)).toBe(AWAY);
    setAddressPick('srv-a', HOME);
    expect(effectiveUrl(conn)).toBe(HOME);
    setAddressPick('srv-a', null);
    expect(effectiveUrl(conn)).toBe(AWAY);
  });

  it('changes nothing (no new picks object) for the same pick', () => {
    setAddressPick('srv-a', HOME);
    const picks = useAddressRoute.getState().picks;
    setAddressPick('srv-a', HOME);
    setAddressPick('other', null);
    expect(useAddressRoute.getState().picks).toBe(picks);
  });

  it('ignores a pick that is no longer one of the connection addresses', () => {
    expect(pickedUrl({ ...conn, addresses: undefined }, HOME)).toBe(AWAY);
    expect(pickedUrl(conn, 'http://10.9.9.9')).toBe(AWAY);
  });

  it('never switches on web: the served player keeps the address it was opened at', () => {
    Platform.OS = 'web';
    expect(pickedUrl(conn, HOME)).toBe(AWAY);
  });
});

describe('useActiveAddress', () => {
  it('says which address is in use, and follows a switch', async () => {
    useSession.setState({ connections: [conn] } as never);
    const { result } = await renderHook(() => useActiveAddress('srv-a'));
    expect(result.current).toEqual({ url: AWAY, kind: 'away' });
    await act(async () => setAddressPick('srv-a', HOME));
    expect(result.current).toEqual({ url: HOME, kind: 'home' });
  });

  it('reads paired for a connection without addresses, and an unknown one', async () => {
    useSession.setState({ connections: [{ ...conn, addresses: undefined }] } as never);
    const { result } = await renderHook(() => [
      useActiveAddress('srv-a'),
      useActiveAddress('nope'),
    ]);
    expect(result.current).toEqual([
      { url: AWAY, kind: 'paired' },
      { url: '', kind: 'paired' },
    ]);
  });

  it('reads home for a device paired at its home address', async () => {
    useSession.setState({ connections: [{ ...conn, serverUrl: HOME }] } as never);
    const { result } = await renderHook(() => useActiveAddress('srv-a'));
    expect(result.current).toEqual({ url: HOME, kind: 'home' });
  });
});
