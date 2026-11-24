/**
 * @jest-environment ./src/testing/jsdom-environment.js
 */

function setup(readyState: DocumentReadyState, dev: boolean, language = 'en', secure = true) {
  jest.resetModules();
  const register = jest.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(document, 'readyState', { value: readyState, configurable: true });
  jest.isolateModules(() => {
    jest.doMock('./base-url', () => ({ BASE_URL: dev ? '' : '/web', IS_DEV: dev }));
    jest.doMock('@/i18n/language-provider', () => ({
      readLanguagePref: () => Promise.resolve('system'),
      resolveLanguage: () => language,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./register-sw.web');
  });
  return register;
}

it('registers even if the export has already fired load', async () => {
  const register = setup('complete', false);
  await Promise.resolve();
  expect(register).toHaveBeenCalledWith('/web/sw.js');
});

it('waits for load, registering with the resolved language for the offline precache', async () => {
  const register = setup('loading', false, 'fr');
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('load'));
  await Promise.resolve();
  expect(register).toHaveBeenCalledWith('/web/sw.js?lang=fr');
});

it('uses media-only mode in dev, whatever the language', () => {
  expect(setup('complete', true, 'es')).toHaveBeenCalledWith('/sw.js?dev=1');
});

it('skips registration on an insecure page', async () => {
  const register = setup('complete', false, 'en', false);
  await Promise.resolve();
  expect(register).not.toHaveBeenCalled();
});
