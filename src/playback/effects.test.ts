import { isWebKitOnly, smartSpeedApplies, supportsVoiceBoost } from './effects';

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  edgeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15',
};

describe('supportsVoiceBoost', () => {
  it('is on in Chromium and Firefox, with Web Audio', () => {
    for (const ua of [UA.chromeMac, UA.edge, UA.firefox, UA.chromeAndroid]) {
      expect(supportsVoiceBoost({ userAgent: ua, hasWebAudio: true })).toBe(true);
    }
  });

  it('is off in Safari and every iPhone browser (all WebKit)', () => {
    for (const ua of [UA.safariMac, UA.safariIphone, UA.chromeIphone, UA.edgeIphone]) {
      expect(isWebKitOnly(ua)).toBe(true);
      expect(supportsVoiceBoost({ userAgent: ua, hasWebAudio: true })).toBe(false);
    }
  });

  it('is off without Web Audio', () => {
    expect(supportsVoiceBoost({ userAgent: UA.chromeMac, hasWebAudio: false })).toBe(false);
  });

  it('reads the running browser by default (no AudioContext under jest)', () => {
    expect(supportsVoiceBoost()).toBe(false);
  });
});

describe('smartSpeedApplies', () => {
  const local = { tracks: [{ url: 'file:///d/1.mp3' }, { url: 'file:///d/2.mp3' }] };
  const mixed = { tracks: [{ url: 'file:///d/1.mp3' }, { url: 'https://s/2.mp3' }] };
  const streaming = { tracks: [{ url: 'https://s/1.mp3' }] };

  it('applies to every book on Android', () => {
    expect(smartSpeedApplies('android', streaming)).toBe(true);
    expect(smartSpeedApplies('android', local)).toBe(true);
  });

  it('applies on iOS only when every file is on the device', () => {
    expect(smartSpeedApplies('ios', local)).toBe(true);
    expect(smartSpeedApplies('ios', mixed)).toBe(false);
    expect(smartSpeedApplies('ios', streaming)).toBe(false);
    expect(smartSpeedApplies('ios', { tracks: [] })).toBe(false);
    expect(smartSpeedApplies('ios', null)).toBe(false);
  });

  it('never applies on the web', () => {
    expect(smartSpeedApplies('web', local)).toBe(false);
  });
});
