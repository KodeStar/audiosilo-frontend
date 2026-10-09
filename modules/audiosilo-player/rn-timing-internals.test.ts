// Node's fs through jest (the app's tsconfig types only jest and react).
declare const __dirname: string;
const { readFileSync } = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const join = (...parts: string[]) => parts.join('/');

/**
 * A React Native upgrade tripwire for `ios/AudiosiloJSTimers.swift` + `ios/CarTimerPolicy.swift`.
 *
 * While CarPlay is the only foreground scene, the module moves React Native's timing module
 * (RCTTiming) onto its NSTimer, because its display link never ticks with no phone scene on
 * screen (every short JS timer stalled after a CarPlay-first launch). In bridgeless mode that
 * RCTTiming is no module: it is reached through private instance variables
 * (`ReactTiming.find`). The Swift side is feature-detected, so a React Native that moves them
 * only turns the fix into a logged no-op, which no test on the web or in jest would notice: this
 * test reads the installed React Native sources and fails instead. On a failure, find the new
 * path from RCTHost to the RCTTiming that `ObjCTimerRegistry` creates, update `ReactTiming.find`
 * and this test, and check a CarPlay-first launch in the Simulator (the car snapshot on disk is
 * rewritten within seconds).
 */
const rn = join(__dirname, '../../node_modules/react-native');
const read = (path: string) => readFileSync(join(rn, path), 'utf8');
const ios = 'ReactCommon/react/runtime/platform/ios/ReactCommon';

describe('React Native internals the CarPlay timer fix relies on', () => {
  it('RCTHost keeps its RCTInstance in `_instance`', () => {
    expect(read(`${ios}/RCTHost.mm`)).toMatch(/RCTInstance \*_instance;/);
  });

  it('RCTInstance keeps an RCTDisplayLink in `_displayLink` and registers the timer registry RCTTiming with it', () => {
    const instance = read(`${ios}/RCTInstance.mm`);
    expect(instance).toMatch(/RCTDisplayLink \*_displayLink;/);
    expect(instance).toMatch(/auto timing = objCTimerRegistry->timing;/);
    expect(instance).toMatch(/registerModuleForFrameUpdates:timing withModuleHolder:moduleHolder/);
    // The holder hands the module back from `instance`.
    expect(instance).toMatch(/- \(id<RCTBridgeModule>\)instance\s*\{\s*return _module;/);
    expect(read(`${ios}/ObjCTimerRegistry.mm`)).toMatch(/\[\[RCTTiming alloc\] initWithDelegate:/);
  });

  it('RCTDisplayLink keeps its holders in `_frameUpdateObservers`', () => {
    expect(read('React/Base/RCTDisplayLink.m')).toMatch(
      /NSMutableSet<id<RCTDisplayLinkModuleHolder>> \*_frameUpdateObservers;/,
    );
  });

  it('RCTTiming switches modes with appDidMoveToBackground / appDidMoveToForeground', () => {
    const timing = read('React/CoreModules/RCTTiming.mm');
    expect(timing).toMatch(/^@implementation RCTTiming\b/m);
    expect(timing).toMatch(/^- \(void\)appDidMoveToBackground$/m);
    expect(timing).toMatch(/^- \(void\)appDidMoveToForeground$/m);
    // Its background mode fires timers from an NSTimer, not the display link.
    expect(timing).toMatch(/if \(_inBackground\) \{\s*\[self scheduleSleepTimer:timer\.target\];/);
  });

  it('RCTReactNativeFactory exposes rootViewFactory.reactHost', () => {
    expect(read('Libraries/AppDelegate/RCTReactNativeFactory.h')).toMatch(
      /RCTRootViewFactory \*rootViewFactory;/,
    );
    expect(read('Libraries/AppDelegate/RCTRootViewFactory.h')).toMatch(/RCTHost \*reactHost;/);
  });

  it('the Swift lookup names the same instance variables', () => {
    const swift = readFileSync(join(__dirname, 'ios/CarTimerPolicy.swift'), 'utf8');
    for (const name of [
      '"_instance"',
      '"_displayLink"',
      '"_frameUpdateObservers"',
      '"RCTTiming"',
    ]) {
      expect(swift).toContain(name);
    }
    expect(readFileSync(join(__dirname, 'ios/AudiosiloJSTimers.swift'), 'utf8')).toContain(
      '"reactNativeFactory"',
    );
    // ...and the AppDelegate withCarPlay.js matches (its SDK template fixture) still names it so.
    expect(
      readFileSync(join(__dirname, '../../plugins/__fixtures__/app-delegate-sdk56.ts'), 'utf8'),
    ).toMatch(/var reactNativeFactory: RCTReactNativeFactory\?/);
  });
});
