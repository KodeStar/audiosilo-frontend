import { Platform } from 'react-native';

import { NATIVE_REM_PT, slopTo44, touchTarget } from './touch-target';

const prevOS = Platform.OS;
afterEach(() => {
  Platform.OS = prevOS;
});

describe('slopTo44', () => {
  it('matches the native rem Uniwind compiles with', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const options = require('../../../uniwind.config') as { polyfills: { rem: number } };
    expect(NATIVE_REM_PT).toBe(options.polyfills.rem);
  });

  it('makes up 44 pt on native and leaves the web as it was', () => {
    Platform.OS = 'ios';
    expect(slopTo44(2.75)).toBe(3); // 38.5 pt
    expect(slopTo44(2.5)).toBe(5); // 35 pt
    expect(slopTo44(2.25)).toBe(7); // 31.5 pt
    Platform.OS = 'web';
    expect(slopTo44(2.75)).toBe(0); // 44 px
    expect(slopTo44(2.5)).toBe(2); // 40 px
    expect(slopTo44(2.25)).toBe(4); // 36 px
  });
});

describe('touchTarget', () => {
  it('gives a native control a real 44 pt frame, never a slop', () => {
    for (const os of ['ios', 'android'] as const) {
      Platform.OS = os;
      expect(touchTarget(1.75)).toEqual({ frameClass: 'min-h-[44px]' });
      expect(touchTarget(2.25, 2.25)).toEqual({ frameClass: 'min-h-[44px] min-w-[44px]' });
    }
  });

  it('grows a web control to 44 px with a slop, on the sides it is sized on', () => {
    Platform.OS = 'web';
    expect(touchTarget(1.75)).toEqual({ hitSlop: { top: 8, bottom: 8 } });
    expect(touchTarget(2.25, 2.25)).toEqual({
      hitSlop: { top: 4, bottom: 4, left: 4, right: 4 },
    });
  });
});
