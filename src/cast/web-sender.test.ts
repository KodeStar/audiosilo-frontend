import {
  CAST_SENDER_URL,
  forgetCastSender,
  isChromium,
  loadCastSender,
  type SenderDocument,
  type SenderWindow,
  webCastSupported,
} from './web-sender';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const IOS_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

describe('webCastSupported', () => {
  it('is Chromium in a secure context only', () => {
    const chrome = { isSecureContext: true, navigator: { userAgent: CHROME_UA }, chrome: {} };
    expect(webCastSupported(chrome)).toBe(true);
    expect(webCastSupported({ ...chrome, isSecureContext: false })).toBe(false); // plain http
    expect(webCastSupported({ isSecureContext: true, navigator: { userAgent: SAFARI_UA } })).toBe(
      false,
    );
    expect(webCastSupported({ isSecureContext: true, navigator: { userAgent: FIREFOX_UA } })).toBe(
      false,
    );
    expect(
      webCastSupported({
        isSecureContext: true,
        navigator: { userAgent: IOS_CHROME_UA },
        chrome: {},
      }),
    ).toBe(false);
    expect(webCastSupported(undefined)).toBe(false);
  });

  it('prefers the client hints brands', () => {
    expect(
      isChromium({
        navigator: {
          userAgentData: { brands: [{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }] },
        },
      }),
    ).toBe(true);
    expect(isChromium({ navigator: { userAgentData: { brands: [{ brand: 'Brave' }] } } })).toBe(
      false,
    );
  });
});

describe('loadCastSender', () => {
  function fakePage() {
    const scripts: { src: string; async: boolean; onerror: ((e: unknown) => void) | null }[] = [];
    const win: SenderWindow = {};
    const doc: SenderDocument = {
      createElement: () => {
        const s = { src: '', async: false, onerror: null as ((e: unknown) => void) | null };
        scripts.push(s);
        return s;
      },
      head: { appendChild: () => undefined },
    };
    return { win, doc, scripts };
  }

  beforeEach(() => {
    forgetCastSender();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it('adds the sender script once and resolves when the framework says it is there', async () => {
    const { win, doc, scripts } = fakePage();
    const a = loadCastSender(win, doc);
    const b = loadCastSender(win, doc);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(CAST_SENDER_URL);
    expect(scripts[0].async).toBe(true);
    win.cast = { framework: {} };
    win.__onGCastApiAvailable?.(true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    // Loaded: no second script.
    await expect(loadCastSender(win, doc)).resolves.toBe(true);
    expect(scripts).toHaveLength(1);
  });

  it('resolves false when the API is unavailable, the script fails or nothing answers, and may retry', async () => {
    let page = fakePage();
    const unavailable = loadCastSender(page.win, page.doc);
    page.win.__onGCastApiAvailable?.(false, 'no');
    await expect(unavailable).resolves.toBe(false);

    page = fakePage();
    const failed = loadCastSender(page.win, page.doc);
    page.scripts[0].onerror?.(new Error('blocked'));
    await expect(failed).resolves.toBe(false);

    page = fakePage();
    const silent = loadCastSender(page.win, page.doc, 1000);
    jest.advanceTimersByTime(1000);
    await expect(silent).resolves.toBe(false);
    loadCastSender(page.win, page.doc);
    expect(page.scripts).toHaveLength(2); // a later need tries again
  });
});
