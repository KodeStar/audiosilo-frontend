import { Platform } from 'react-native';

import { fakeBrowser } from '@/testing/fake-browser';

import { tabChannel, tabChannelKey } from './tab-channel';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('tabChannel', () => {
  const os = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = os;
  });

  it('is nothing off the web: the app is one runtime', () => {
    Platform.OS = 'ios';
    expect(tabChannel('x', fakeBrowser().tab())).toBeNull();
    Platform.OS = 'android';
    expect(tabChannel('x', fakeBrowser().tab())).toBeNull();
  });

  describe.each([
    ['BroadcastChannel', true],
    ['storage events (a browser without BroadcastChannel)', false],
  ])('over %s', (_name, broadcast) => {
    it('a message reaches every other tab, never the one that posted it', async () => {
      const browser = fakeBrowser({ broadcast });
      const [a, b, c] = [1, 2, 3].map(() => tabChannel<{ n: number }>('x', browser.tab())!);
      const heard: string[] = [];
      a.subscribe((m) => heard.push(`a${m.n}`));
      b.subscribe((m) => heard.push(`b${m.n}`));
      c.subscribe((m) => heard.push(`c${m.n}`));
      a.post({ n: 1 });
      await settle();
      expect(heard.sort()).toEqual(['b1', 'c1']);
      heard.length = 0;
      b.post({ n: 2 });
      await settle();
      expect(heard.sort()).toEqual(['a2', 'c2']);
    });

    it('the same message twice is heard twice', async () => {
      const browser = fakeBrowser({ broadcast });
      const a = tabChannel<string>('x', browser.tab())!;
      const b = tabChannel<string>('x', browser.tab())!;
      const heard: string[] = [];
      b.subscribe((m) => heard.push(m));
      a.post('again');
      a.post('again');
      await settle();
      expect(heard).toEqual(['again', 'again']);
    });

    it('another channel hears nothing, and an unsubscribed listener no more', async () => {
      const browser = fakeBrowser({ broadcast });
      const a = tabChannel<string>('x', browser.tab())!;
      const tabB = browser.tab();
      const b = tabChannel<string>('x', tabB)!;
      const other = tabChannel<string>('y', tabB)!;
      const heard: string[] = [];
      other.subscribe((m) => heard.push(`y:${m}`));
      const stop = b.subscribe((m) => heard.push(`x:${m}`));
      a.post('one');
      await settle();
      stop();
      a.post('two');
      await settle();
      expect(heard).toEqual(['x:one']);
    });
  });

  it('the storage fallback leaves nothing stored, and ignores what is not its message', async () => {
    const browser = fakeBrowser({ broadcast: false });
    const tabA = browser.tab();
    const a = tabChannel<string>('x', tabA)!;
    const b = tabChannel<string>('x', browser.tab())!;
    const heard: string[] = [];
    b.subscribe((m) => heard.push(m));
    a.post('hello');
    expect(browser.data.size).toBe(0); // a wire, not a document
    // Another key, and garbage under the channel's own.
    tabA.localStorage.setItem('audiosilo.listeningOutbox', '[]');
    tabA.localStorage.setItem(tabChannelKey('x'), '{not json');
    tabA.localStorage.setItem(tabChannelKey('x'), '"a bare string"');
    await settle();
    expect(heard).toEqual(['hello']);
  });

  it('falls back to storage events when a BroadcastChannel cannot be opened', async () => {
    const browser = fakeBrowser({ broadcast: false });
    const refusing = {
      ...browser.tab(),
      BroadcastChannel: class {
        constructor() {
          throw new Error('SecurityError');
        }
      } as never,
    };
    const a = tabChannel<string>('x', refusing)!;
    const heard: string[] = [];
    tabChannel<string>('x', browser.tab())!.subscribe((m) => heard.push(m));
    a.post('through storage');
    await settle();
    expect(heard).toEqual(['through storage']);
  });

  it('is nothing in a browser with neither', () => {
    expect(tabChannel('x', {})).toBeNull();
    const refused = {
      get localStorage(): never {
        throw new Error('SecurityError');
      },
      addEventListener: () => {},
    };
    expect(tabChannel('x', refused)).toBeNull();
  });

  it('a post that storage refuses tells nobody and does not throw', () => {
    const tab = refusingWrites();
    expect(() => tabChannel<string>('x', tab)!.post('lost')).not.toThrow();
  });
});

function refusingWrites() {
  return {
    localStorage: {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
