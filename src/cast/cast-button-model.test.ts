import { castButtonModel } from './cast-button-model';

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

  // Bridge Phase 2d-1: a cast token never covers a podcast episode.
  it('hides it for a podcast episode, unless a session runs', () => {
    expect(castButtonModel({ ...base, episode: true }).show).toBe(false);
    expect(castButtonModel({ ...base, episode: true, status: 'connected' }).show).toBe(true);
  });
});
