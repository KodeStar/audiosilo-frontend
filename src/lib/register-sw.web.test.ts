/**
 * @jest-environment jsdom
 */

type Module = typeof import('./register-sw.web');

// The module registers on import; each test sets the page up first, then requires it.
function setup(readyState: DocumentReadyState, { dev = true } = {}) {
  jest.resetModules();
  const register = jest.fn(() => Promise.resolve());
  const postMessage = jest.fn();
  const ready = Promise.resolve({ active: { postMessage } });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register, ready },
    configurable: true,
  });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(document, 'readyState', { value: readyState, configurable: true });
  let mod!: Module;
  jest.isolateModules(() => {
    jest.doMock('./base-url', () => ({ BASE_URL: dev ? '' : '/web', IS_DEV: dev }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./register-sw.web');
  });
  return { register, postMessage, mod };
}

/** The static export's script tags: the runtime, route chunks, then the entry last. */
function addScripts(...names: string[]) {
  for (const name of names) {
    const s = document.createElement('script');
    s.src = `/web/_expo/static/js/web/${name}.js`;
    document.head.appendChild(s);
  }
}

afterEach(() => {
  document.head.innerHTML = '';
  jest.useRealTimers();
});

describe('registerServiceWorker', () => {
  it('registers at once when the page has already loaded', () => {
    // The root layout is required during the first render, after `load` in the export.
    const { register } = setup('complete');
    expect(register).toHaveBeenCalledWith(expect.stringMatching(/\/sw\.js/));
  });

  it('waits for load when the page is still loading', () => {
    const { register } = setup('loading');
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('registers the worker under the build it runs (its entry and shared chunk), in production', () => {
    addScripts('__expo-metro-runtime-aaa', '_layout-bbb', '__common-ccc', 'index-ddd');
    const { register } = setup('complete', { dev: false });
    expect(register).toHaveBeenCalledWith('/web/sw.js?build=index-ddd.__common-ccc');
  });

  it('keeps the dev worker on ?dev=1', () => {
    addScripts('index-ddd');
    const { register } = setup('complete', { dev: true });
    expect(register).toHaveBeenCalledWith('/sw.js?dev=1');
  });

  it('asks the worker to precache the build a while after registering, in production', async () => {
    jest.useFakeTimers();
    const { postMessage, mod } = setup('complete', { dev: false });
    jest.advanceTimersByTime(mod.PRECACHE_DELAY_MS - 1);
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ type: 'precache' });
  });

  it('never asks in dev', () => {
    jest.useFakeTimers();
    const { postMessage, mod } = setup('complete', { dev: true });
    jest.advanceTimersByTime(mod.PRECACHE_DELAY_MS * 2);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('buildId', () => {
  it('is the last bundle script, without one undefined', () => {
    const { mod } = setup('loading');
    expect(mod.buildId()).toBeUndefined();
    addScripts('_layout-bbb', 'index-ddd');
    expect(mod.buildId()).toBe('index-ddd');
  });

  it('names the shared chunk too (a fix there leaves the entry as it was), whatever the page', () => {
    const { mod } = setup('loading');
    addScripts(
      '__expo-metro-runtime-aaa',
      '_layout-bbb',
      'settings-eee',
      '__common-ccc',
      'index-ddd',
    );
    expect(mod.buildId()).toBe('index-ddd.__common-ccc');
    document.head.innerHTML = '';
    addScripts(
      '__expo-metro-runtime-aaa',
      '_layout-bbb',
      'library-fff',
      '__common-ccc',
      'index-ddd',
    );
    expect(mod.buildId()).toBe('index-ddd.__common-ccc');
  });

  it('names the last part of the entry and the first of the shared chunk in a cut build', () => {
    // The export cuts its big start scripts into parts (scripts/web-start-chunks.cjs).
    const { mod } = setup('loading');
    addScripts(
      '__expo-metro-runtime-aaa',
      '__common-ccc-1',
      '__common-ccc-2',
      'index-ddd-1',
      'index-ddd-2',
    );
    expect(mod.buildId()).toBe('index-ddd-2.__common-ccc-1');
  });
});
