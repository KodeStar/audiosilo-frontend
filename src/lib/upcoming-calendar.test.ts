import { Linking, Platform } from 'react-native';

import type { Capabilities } from '@/api/types';
import { getSecure, setSecure } from '@/lib/secure-store';

import {
  calendarConnections,
  calendarFeedUrl,
  calendarLinkKey,
  calendarRowState,
  canSubscribeWebcal,
  forgetCalendarLink,
  openWebcal,
  readCalendarLink,
  saveCalendarLink,
  webcalUrl,
} from './upcoming-calendar';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const PATH = '/api/v1/me/upcoming/releases.ics?token=secret';
const CREATED = '2026-10-30T09:00:00Z';

describe('calendarFeedUrl', () => {
  it('puts the path on the away address when the server has one', () => {
    expect(
      calendarFeedUrl(PATH, { away: 'https://books.example/' }, 'http://192.168.1.5:8080'),
    ).toBe(`https://books.example${PATH}`);
  });

  it('else on the address this device reaches the server at', () => {
    expect(calendarFeedUrl(PATH, undefined, 'https://h')).toBe(`https://h${PATH}`);
    expect(calendarFeedUrl(PATH, { away: '' }, 'https://h/')).toBe(`https://h${PATH}`);
    expect(calendarFeedUrl(PATH.slice(1), {}, 'https://h')).toBe(`https://h${PATH}`);
  });
});

describe('webcalUrl', () => {
  it('swaps http(s) for webcal, and refuses anything else', () => {
    expect(webcalUrl(`https://h${PATH}`)).toBe(`webcal://h${PATH}`);
    expect(webcalUrl(`HTTP://h${PATH}`)).toBe(`webcal://h${PATH}`);
    expect(webcalUrl('javascript:alert(1)')).toBeNull();
    expect(webcalUrl('webcal://h/x')).toBeNull();
  });
});

describe('canSubscribeWebcal', () => {
  it('is the iOS app and a browser on an Apple device', () => {
    expect(canSubscribeWebcal('ios', undefined)).toBe(true);
    expect(canSubscribeWebcal('web', MAC)).toBe(true);
    expect(canSubscribeWebcal('web', IPHONE)).toBe(true);
  });

  it('is not Android (app or browser), Windows, or an unknown browser', () => {
    expect(canSubscribeWebcal('android', MAC)).toBe(false);
    expect(canSubscribeWebcal('web', ANDROID)).toBe(false);
    expect(canSubscribeWebcal('web', WINDOWS)).toBe(false);
    expect(canSubscribeWebcal('web', undefined)).toBe(false);
  });
});

describe('openWebcal', () => {
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
  });

  it('opens the webcal form through Linking in the app', async () => {
    Platform.OS = 'ios';
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openWebcal(`https://h${PATH}`);
    expect(open).toHaveBeenCalledWith(`webcal://h${PATH}`);
    open.mockRestore();
  });

  it('opens nothing for a link that is not http(s)', async () => {
    Platform.OS = 'ios';
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openWebcal('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe('calendarConnections', () => {
  const caps = (c: Partial<Capabilities>) => c as Capabilities;

  it('has a row for each connection whose server offers it, kids never', () => {
    expect(
      calendarConnections(
        [
          { id: 'a', user: {} },
          { id: 'kid', user: { member_kind: 'kid' } },
          { id: 'demo', user: { is_demo: true } },
          { id: 'off', user: {} },
          { id: 'old', user: {} },
          { id: 'loading', user: {} },
        ],
        {
          a: caps({ upcoming_calendar: true }),
          kid: caps({ upcoming_calendar: true }),
          demo: caps({ upcoming_calendar: true }),
          off: caps({ upcoming_calendar: false }),
          old: caps({ upcoming: true }),
          loading: undefined,
        },
      ),
    ).toEqual([
      { id: 'a', demo: false },
      { id: 'demo', demo: true },
    ]);
  });
});

describe('calendarRowState', () => {
  const stored = { url: `https://h${PATH}`, created_at: CREATED };

  it('waits for both the status and this device copy', () => {
    expect(calendarRowState({ status: undefined, failed: false, stored })).toEqual({
      kind: 'loading',
      staleCopy: false,
    });
    expect(
      calendarRowState({ status: { active: false }, failed: false, stored: undefined }),
    ).toEqual({ kind: 'loading', staleCopy: false });
  });

  it('is an error when the status could not be read', () => {
    expect(calendarRowState({ status: undefined, failed: true, stored: null }).kind).toBe('error');
  });

  it('has no link while none is active, and a copy of a dead one is stale', () => {
    expect(calendarRowState({ status: { active: false }, failed: false, stored: null })).toEqual({
      kind: 'none',
      staleCopy: false,
    });
    expect(calendarRowState({ status: { active: false }, failed: false, stored })).toEqual({
      kind: 'none',
      staleCopy: true,
    });
  });

  it('shows the copy of the active link (the same instant in any form)', () => {
    expect(
      calendarRowState({
        status: { active: true, created_at: '2026-10-30T09:00:00.000Z' },
        failed: false,
        stored,
      }),
    ).toEqual({ kind: 'shown', url: stored.url, staleCopy: false });
    // An answer without created_at can't tell: the copy stands.
    expect(calendarRowState({ status: { active: true }, failed: false, stored }).kind).toBe(
      'shown',
    );
  });

  it('is elsewhere when this device has no copy, or a copy of a replaced link', () => {
    const active = { active: true, created_at: '2026-10-31T10:00:00Z' };
    expect(calendarRowState({ status: active, failed: false, stored: null })).toEqual({
      kind: 'elsewhere',
      staleCopy: false,
    });
    expect(calendarRowState({ status: active, failed: false, stored })).toEqual({
      kind: 'elsewhere',
      staleCopy: true,
    });
  });
});

describe('the device copy', () => {
  it('is kept in the secure store per connection, read back, and forgotten', async () => {
    await saveCalendarLink('s.1', { url: `https://h${PATH}`, created_at: CREATED });
    expect(await getSecure(calendarLinkKey('s.1'))).toContain('secret');
    await expect(readCalendarLink('s.1')).resolves.toEqual({
      url: `https://h${PATH}`,
      created_at: CREATED,
    });
    await expect(readCalendarLink('s.2')).resolves.toBeNull();
    await forgetCalendarLink('s.1');
    await expect(readCalendarLink('s.1')).resolves.toBeNull();
  });

  it('reads anything it did not write as none', async () => {
    await setSecure(calendarLinkKey('s.3'), 'not json');
    await expect(readCalendarLink('s.3')).resolves.toBeNull();
    await setSecure(calendarLinkKey('s.3'), JSON.stringify({ url: 1 }));
    await expect(readCalendarLink('s.3')).resolves.toBeNull();
  });
});
