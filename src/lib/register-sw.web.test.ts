/**
 * @jest-environment jsdom
 */

// The module registers on import; each test sets the page up first, then requires it.
function setup(readyState: DocumentReadyState) {
  jest.resetModules();
  const register = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(document, 'readyState', { value: readyState, configurable: true });
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./register-sw.web');
  });
  return register;
}

describe('registerServiceWorker', () => {
  it('registers at once when the page has already loaded', () => {
    // The root layout is required during the first render, after `load` in the export.
    const register = setup('complete');
    expect(register).toHaveBeenCalledWith(expect.stringMatching(/\/sw\.js/));
  });

  it('waits for load when the page is still loading', () => {
    const register = setup('loading');
    expect(register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    expect(register).toHaveBeenCalledTimes(1);
  });
});
