// The jsdom environment for the suites that need a real DOM (`@jest-environment
// ./src/testing/jsdom-environment.js`): jest-environment-jsdom with two fixes that
// jest-expo's own (native) environment needs on Jest 30 too.
// 1. React Native's jest preset setup defines `window` on the global as the global
//    itself. Under jsdom the global IS the window, whose `window` property cannot be
//    redefined, so that one property is dropped from the setup's
//    `Object.defineProperties` call (it already holds).
// 2. Clearing mocks reads every enumerable global, and Expo installs lazy globals
//    (`fetch`, `TextEncoderStream`...) as getters that `require` on first read, which
//    throws once a test has ended: only data properties are read (as jest-expo's
//    `nativeEnvironment.js` does).
const { TestEnvironment } = require('jest-environment-jsdom');

function clearMocksOnScope(scope) {
  for (const key of Object.keys(scope)) {
    const descriptor = Object.getOwnPropertyDescriptor(scope, key);
    if (!descriptor || typeof descriptor.get === 'function') continue;
    const value = descriptor.value;
    if (
      value != null &&
      (typeof value === 'object' || typeof value === 'function') &&
      '_isMockFunction' in value &&
      this.isMockFunction(value) &&
      typeof value.mockClear === 'function'
    ) {
      value.mockClear();
    }
  }
}

class JsdomEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.moduleMocker.clearMocksOnScope = clearMocksOnScope;
    const global = this.global;
    const define = global.Object.defineProperties;
    global.Object.defineProperties = function defineProperties(target, props) {
      if (target === global && props && 'window' in props && global.window === global) {
        const { window: _window, ...rest } = props;
        return define.call(this, target, rest);
      }
      return define.call(this, target, props);
    };
  }
}

module.exports = JsdomEnvironment;
module.exports.TestEnvironment = JsdomEnvironment;
