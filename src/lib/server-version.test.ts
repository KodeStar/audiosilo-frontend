import { versionAtLeast } from './server-version';

describe('versionAtLeast', () => {
  it.each<[string | undefined, string, boolean | undefined]>([
    ['2.6.0', '2.6.0', true],
    ['v2.6.1', '2.6.0', true],
    ['2.10.0', '2.6.0', true],
    ['3.0.0', '2.6.0', true],
    ['2.6.0-rc.1', '2.6.0', true],
    ['2.5.9', '2.6.0', false],
    ['1.17.0', '2.6.0', false],
    ['dev', '2.6.0', undefined],
    [undefined, '2.6.0', undefined],
  ])('%s against %s is %s', (version, min, want) => {
    expect(versionAtLeast(version, min)).toBe(want);
  });
});
