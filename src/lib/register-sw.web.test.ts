/**
 * @jest-environment ./src/testing/jsdom-environment.js
 */

function setup(
  readyState: DocumentReadyState,
  dev: boolean,
  language = 'en',
  secure = true,
  registration: object = { installing: null },
) {
  jest.resetModules();
  const register = jest.fn(() => Promise.resolve(registration));
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

/** Let the registration's awaits (the saved language) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('registers even if the export has already fired load', async () => {
  const register = setup('complete', false);
  await settle();
  expect(register).toHaveBeenCalledWith('/web/sw.js');
});

it('waits for load, registering with the resolved language for the offline precache', async () => {
  const register = setup('loading', false, 'fr');
  expect(register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('load'));
  await settle();
  expect(register).toHaveBeenCalledWith('/web/sw.js?lang=fr');
});

it('uses media-only mode in dev, whatever the language', () => {
  expect(setup('complete', true, 'es')).toHaveBeenCalledWith('/sw.js?dev=1');
});

it('skips registration on an insecure page', async () => {
  const register = setup('complete', false, 'en', false);
  await settle();
  expect(register).not.toHaveBeenCalled();
});

/** A registration whose new worker is installing over `activeUrl`'s. */
function updating(activeUrl: string) {
  const installing = Object.assign(new EventTarget(), { state: 'installing' });
  const active = { scriptURL: activeUrl, postMessage: jest.fn() };
  const fail = () => {
    installing.state = 'redundant';
    installing.dispatchEvent(new Event('statechange'));
  };
  return { registration: { installing, active }, active, fail };
}

it('asks a worker from before the build manifest to precache when the new one fails to install', async () => {
  const { registration, active, fail } = updating('https://h/web/sw.js?build=old');
  setup('complete', false, 'en', true, registration);
  await settle();
  expect(active.postMessage).not.toHaveBeenCalled();
  fail();
  expect(active.postMessage).toHaveBeenCalledWith({ type: 'precache' });
});

it('asks nothing of a current worker kept after a failed update', async () => {
  const { registration, active, fail } = updating('https://h/web/sw.js?lang=fr');
  setup('complete', false, 'en', true, registration);
  await settle();
  fail();
  expect(active.postMessage).not.toHaveBeenCalled();
});
