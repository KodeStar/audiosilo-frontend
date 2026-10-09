import { effectsPill, smartSpeedRow, voiceBoostRow } from './effects-model';

describe('smartSpeedRow', () => {
  it('is off and disabled on the web, saying why', () => {
    expect(smartSpeedRow({ platform: 'web', on: true, savedSeconds: 500 })).toEqual({
      checked: false,
      disabled: true,
      lines: ['notInBrowser'],
    });
  });

  it('says what it does, and the time saved once there is some', () => {
    expect(smartSpeedRow({ platform: 'android', on: true, savedSeconds: 0.4 })).toEqual({
      checked: true,
      disabled: false,
      lines: ['hint'],
    });
    expect(smartSpeedRow({ platform: 'android', on: false, savedSeconds: 7860 }).lines).toEqual([
      'hint',
      'saved',
    ]);
  });

  it('is off and disabled on an iPhone, saying why, even with the setting on', () => {
    expect(smartSpeedRow({ platform: 'ios', on: true, savedSeconds: 7860 })).toEqual({
      checked: false,
      disabled: true,
      lines: ['notOnIphone'],
    });
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

  it('on an iPhone, reads only Voice boost (no Smart Speed there)', () => {
    const ios = { ...base, platform: 'ios', smartSpeed: true, savedSeconds: 7860 };
    expect(effectsPill(ios)).toBeNull();
    expect(effectsPill({ ...ios, voiceBoost: true })).toEqual({ kind: 'voiceBoost' });
  });

  it('reads Voice boost on the web, only where it runs', () => {
    const web = { ...base, platform: 'web', smartSpeed: true, savedSeconds: 900 };
    expect(effectsPill({ ...web, voiceBoost: true })).toEqual({ kind: 'voiceBoost' });
    expect(effectsPill({ ...web, voiceBoost: true, voiceBoostSupported: false })).toBeNull();
    expect(effectsPill(web)).toBeNull();
  });
});
