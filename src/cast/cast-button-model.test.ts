import { castButtonModel, sdkButtonDraws } from './cast-button-model';

const base = {
  loaded: true,
  supported: true,
  canCast: true,
  canTranscode: true,
  baseUrl: 'http://192.168.1.5:8080',
  status: 'off' as const,
  deviceName: null,
};

describe('castButtonModel', () => {
  it('shows the button for a loaded book whose server has cast, on a device that can cast', () => {
    expect(castButtonModel(base)).toEqual({
      show: true,
      blocked: null,
      status: 'off',
      deviceName: null,
    });
  });

  it('hides it for an older server, an unknown server, a device that cannot cast, or no book', () => {
    expect(castButtonModel({ ...base, canCast: false }).show).toBe(false);
    expect(castButtonModel({ ...base, canCast: undefined }).show).toBe(false);
    expect(castButtonModel({ ...base, supported: false }).show).toBe(false);
    expect(castButtonModel({ ...base, supported: null }).show).toBe(false);
    expect(castButtonModel({ ...base, loaded: false }).show).toBe(false);
  });

  it('keeps it while a session runs, so it can always be stopped', () => {
    const m = castButtonModel({
      ...base,
      loaded: false,
      canCast: undefined,
      status: 'connected',
      deviceName: 'Living room',
    });
    expect(m).toEqual({
      show: true,
      blocked: null,
      status: 'connected',
      deviceName: 'Living room',
    });
  });

  it('explains instead of casting when the address is this device or the codec needs a missing transcoder', () => {
    expect(castButtonModel({ ...base, baseUrl: 'http://localhost:8080' }).blocked).toBe(
      'local-address',
    );
    expect(castButtonModel({ ...base, canTranscode: false, book: { codec: 'alac' } }).blocked).toBe(
      'codec',
    );
    expect(castButtonModel({ ...base, book: { codec: 'alac' } }).blocked).toBeNull();
  });

  it('explains instead of casting when the address in use is behind an auth proxy (fe#167)', () => {
    expect(castButtonModel({ ...base, proxied: true }).blocked).toBe('proxy');
    expect(castButtonModel({ ...base, proxied: false }).blocked).toBeNull();
  });

  // Bridge Phase 2d-1: a cast token never covers a podcast episode.
  it('hides it for a podcast episode, unless a session runs', () => {
    expect(castButtonModel({ ...base, episode: true }).show).toBe(false);
    expect(castButtonModel({ ...base, episode: true, status: 'connected' }).show).toBe(true);
  });
});

describe('sdkButtonDraws', () => {
  it('draws while a device is found or a session runs, and while the state is unknown', () => {
    for (const state of ['notConnected', 'connecting', 'connected', null, undefined]) {
      expect(sdkButtonDraws(state, 'ios', true)).toBe(true);
      expect(sdkButtonDraws(state, 'android', null)).toBe(true);
    }
  });

  it('does not draw with no device found (the empty pill)', () => {
    expect(sdkButtonDraws('noDevicesAvailable', 'android', null)).toBe(false);
    expect(sdkButtonDraws('noDevicesAvailable', 'ios', true)).toBe(false);
  });

  it('draws on iOS before discovery has run, so its first tap can start it', () => {
    expect(sdkButtonDraws('noDevicesAvailable', 'ios', false)).toBe(true);
    expect(sdkButtonDraws('noDevicesAvailable', 'ios', null)).toBe(true);
  });
});
