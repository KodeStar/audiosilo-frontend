import { Platform } from 'react-native';

import { NATIVE_REM_PT, slopTo44 } from './control-pill';

describe('slopTo44', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

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
