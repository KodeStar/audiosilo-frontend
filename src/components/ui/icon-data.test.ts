import { ICON_DATA, type IconName } from './icon-data';

const names = Object.keys(ICON_DATA) as IconName[];

describe('icon-data (vendored FontAwesome SVG)', () => {
  it('vendors a glyph for every icon', () => {
    // Sanity check the generator output isn't empty/truncated.
    expect(names.length).toBeGreaterThanOrEqual(36);
  });

  it.each(names)('%s has a valid single-path glyph', (name) => {
    const { width, height, path } = ICON_DATA[name];
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // A non-empty path that starts with a moveto - i.e. real SVG data, not a stub.
    expect(path).toMatch(/^[Mm]/);
    // No quotes/backslashes: icon.tsx inlines these as `d=` and the generator
    // single-quotes them, so either would corrupt the file.
    expect(path).not.toMatch(/['"\\]/);
  });
});
