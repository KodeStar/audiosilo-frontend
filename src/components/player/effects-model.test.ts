import { effectsPill, smartSpeedRow, voiceBoostRow } from './effects-model';

const local = { tracks: [{ url: 'file:///d/1.mp3' }] };
const streaming = { tracks: [{ url: 'https://s/1.mp3' }] };

describe('smartSpeedRow', () => {
  it('is off and disabled on the web, saying why', () => {
    expect(smartSpeedRow({ platform: 'web', on: true, savedSeconds: 500, queue: local })).toEqual({
      checked: false,
      disabled: true,
      lines: ['notInBrowser'],
    });
  });

  it('says what it does, and the time saved once there is some', () => {
    expect(
      smartSpeedRow({ platform: 'android', on: true, savedSeconds: 0.4, queue: null }),
    ).toEqual({ checked: true, disabled: false, lines: ['hint'] });
    expect(
      smartSpeedRow({ platform: 'android', on: false, savedSeconds: 7860, queue: null }).lines,
    ).toEqual(['hint', 'saved']);
  });

  it('on an iPhone, with it on, flags a book that is not all on the device', () => {
    const row = (on: boolean, queue: typeof local | null) =>
      smartSpeedRow({ platform: 'ios', on, savedSeconds: 0, queue }).lines;
    expect(row(true, streaming)).toEqual(['hint', 'downloadedOnly']);
    expect(row(true, null)).toEqual(['hint', 'downloadedOnly']);
    expect(row(true, local)).toEqual(['hint']);
    expect(row(false, streaming)).toEqual(['hint']);
  });
});

describe('voiceBoostRow', () => {
  it('works on native and in browsers that can run it', () => {
    expect(voiceBoostRow({ platform: 'ios', on: true, supported: false })).toEqual({
      checked: true,
      disabled: false,
      lines: ['hint'],
    });
    expect(voiceBoostRow({ platform: 'web', on: true, supported: true }).checked).toBe(true);
  });

  it('is off and disabled in a browser that cannot (Safari), saying why', () => {
    expect(voiceBoostRow({ platform: 'web', on: true, supported: false })).toEqual({
      checked: false,
      disabled: true,
      lines: ['notInThisBrowser'],
    });
  });
});

describe('effectsPill', () => {
  const base = {
    platform: 'android',
    smartSpeed: false,
    voiceBoost: false,
    voiceBoostSupported: true,
    savedSeconds: 0,
  };

  it('is nothing with both off', () => {
    expect(effectsPill(base)).toBeNull();
    expect(effectsPill({ ...base, platform: 'web' })).toBeNull();
  });

  it('reads the time saved on native while Smart Speed is on and has saved some', () => {
    expect(
      effectsPill({ ...base, smartSpeed: true, voiceBoost: true, savedSeconds: 7860 }),
    ).toEqual({ kind: 'saved', seconds: 7860 });
    expect(effectsPill({ ...base, smartSpeed: true })).toEqual({ kind: 'smartSpeed' });
    expect(effectsPill({ ...base, voiceBoost: true, savedSeconds: 7860 })).toEqual({
      kind: 'voiceBoost',
    });
  });

  it('reads Voice boost on the web, only where it runs', () => {
    const web = { ...base, platform: 'web', smartSpeed: true, savedSeconds: 900 };
    expect(effectsPill({ ...web, voiceBoost: true })).toEqual({ kind: 'voiceBoost' });
    expect(effectsPill({ ...web, voiceBoost: true, voiceBoostSupported: false })).toBeNull();
    expect(effectsPill(web)).toBeNull();
  });
});
