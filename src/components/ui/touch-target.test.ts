import { Platform } from 'react-native';

import { minTarget, NATIVE_REM_PT, slopForPx, slopTo44, touchTarget } from './touch-target';

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
    Platform.OS = 'android';
    expect(slopTo44(2.75)).toBe(5); // 38.5 dp to 48
    expect(minTarget()).toBe(48);
    Platform.OS = 'web';
    expect(minTarget()).toBe(44);
    expect(slopTo44(2.75)).toBe(0); // 44 px
    expect(slopTo44(2.5)).toBe(2); // 40 px
    expect(slopTo44(2.25)).toBe(4); // 36 px
  });
});

describe('slopForPx', () => {
  it('grows a px-sized control to 44 on iOS and the web, 48 dp on Android', () => {
    for (const os of ['ios', 'web'] as const) {
      Platform.OS = os;
      expect(slopForPx(30)).toBe(7);
      expect(slopForPx(38)).toBe(3);
      expect(slopForPx(46)).toBe(0);
    }
    Platform.OS = 'android';
    expect(slopForPx(30)).toBe(9);
    expect(slopForPx(38)).toBe(5);
    expect(slopForPx(46)).toBe(1);
    expect(slopForPx(54)).toBe(0);
  });
});

describe('touchTarget', () => {
  it('gives a native control a real frame (44 pt on iOS, 48 dp on Android), never a slop', () => {
    Platform.OS = 'ios';
    expect(touchTarget(1.75)).toEqual({ frameClass: 'min-h-[44px]' });
    expect(touchTarget(2.25, 2.25)).toEqual({ frameClass: 'min-h-[44px] min-w-[44px]' });
    Platform.OS = 'android';
    expect(touchTarget(1.75)).toEqual({ frameClass: 'min-h-[48px]' });
    expect(touchTarget(2.25, 2.25)).toEqual({ frameClass: 'min-h-[48px] min-w-[48px]' });
  });

  it('grows a web control to 44 px with a slop, on the sides it is sized on', () => {
    Platform.OS = 'web';
    expect(touchTarget(1.75)).toEqual({ hitSlop: { top: 8, bottom: 8 } });
    expect(touchTarget(2.25, 2.25)).toEqual({
      hitSlop: { top: 4, bottom: 4, left: 4, right: 4 },
    });
  });
});
