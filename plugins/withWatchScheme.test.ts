/* eslint-disable @typescript-eslint/no-require-imports -- config plugins are CommonJS */
const withWatchScheme = require('./withWatchScheme');
/* eslint-enable @typescript-eslint/no-require-imports */

type Section = Record<string, unknown>;
const project = (section: Section) => ({ pbxNativeTargetSection: () => section });

describe('withWatchScheme', () => {
  it('finds the watch target and its product among the native targets', () => {
    const section = {
      '13B07F861A680F5B00A75B9A': { name: 'AudioSilo', productReference_comment: 'AudioSilo.app' },
      '13B07F861A680F5B00A75B9A_comment': 'AudioSilo',
      XXAB12XX: { name: '"AudioSiloWatch"', productReference_comment: 'AudioSiloWatch.app' },
      XXAB12XX_comment: 'AudioSiloWatch',
    };
    expect(withWatchScheme.findWatchTarget(project(section))).toEqual({
      targetId: 'XXAB12XX',
      productName: 'AudioSiloWatch.app',
    });
  });

  it('finds nothing when the watch target is missing (the scheme is then not written)', () => {
    const section = {
      '13B07F861A680F5B00A75B9A': { name: 'AudioSilo' },
      '13B07F861A680F5B00A75B9A_comment': 'AudioSilo',
    };
    expect(withWatchScheme.findWatchTarget(project(section))).toBeNull();
  });

  it('builds, runs and profiles only the watch target', () => {
    const xml: string = withWatchScheme.watchScheme({
      targetId: 'XXAB12XX',
      productName: 'AudioSiloWatch.app',
      container: 'AudioSilo.xcodeproj',
    });
    // One build entry plus the run and profile runnables, all the watch app.
    expect(xml.match(/<BuildableReference/g)).toHaveLength(3);
    expect(xml.match(/BlueprintIdentifier = "XXAB12XX"/g)).toHaveLength(3);
    expect(xml).toContain('BuildableName = "AudioSiloWatch.app"');
    expect(xml).toContain('ReferencedContainer = "container:AudioSilo.xcodeproj"');
    expect(xml).not.toContain('"AudioSilo.app"');
  });
});
