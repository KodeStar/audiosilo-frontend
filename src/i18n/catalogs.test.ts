import i18n, { ensureLanguage, SUPPORTED_CODES, switchLanguage } from '@/i18n';

import * as catalogs from './catalogs';
import {
  BUNDLED_CATALOGS as WEB_BUNDLED,
  CATALOG_LOADERS as WEB_LOADERS,
  loadCatalog as loadWebCatalog,
} from './catalogs.web';
import de from './locales/de.json';
import fr from './locales/fr.json';

const others = SUPPORTED_CODES.filter((c) => c !== 'en').sort();

describe('catalogs', () => {
  it('starts with English alone, on native (the tests run as native) as on the web', () => {
    expect(Object.keys(catalogs.BUNDLED_CATALOGS)).toEqual(['en']);
    expect(Object.keys(WEB_BUNDLED)).toEqual(['en']);
  });

  it('has a loader for every other language on both', () => {
    expect(Object.keys(catalogs.CATALOG_LOADERS).sort()).toEqual(others);
    expect(Object.keys(WEB_LOADERS).sort()).toEqual(others);
  });

  it('native requires a catalog only when it is asked for (PERF-SPIKE P5)', async () => {
    const loaders = { de: jest.fn(() => de), fr: jest.fn(() => fr) };
    expect(await catalogs.loadCatalog('en', loaders)).toBe(catalogs.BUNDLED_CATALOGS.en);
    expect(loaders.de).not.toHaveBeenCalled();
    expect(await catalogs.loadCatalog('de', loaders)).toBe(de);
    expect(loaders.de).toHaveBeenCalledTimes(1);
    expect(loaders.fr).not.toHaveBeenCalled();
    expect(await catalogs.loadCatalog('xx', loaders)).toBeUndefined();
  });

  it("native's own loaders give each language's catalog", async () => {
    for (const code of others) {
      const catalog = await catalogs.loadCatalog(code);
      expect(catalog).toBeDefined();
      expect(catalog).not.toBe(catalogs.BUNDLED_CATALOGS.en);
    }
    expect(await catalogs.loadCatalog('de')).toEqual(de);
  });

  it('the web loads a catalog from its chunk, English from the bundle', async () => {
    // jest runs no dynamic import(): the chunks stand in as loaders.
    const loaders = { fr: () => Promise.resolve({ default: fr }) };
    expect(await loadWebCatalog('fr', loaders)).toBe(fr);
    expect(await loadWebCatalog('en', loaders)).toBe(WEB_BUNDLED.en);
    expect(await loadWebCatalog('xx', loaders)).toBeUndefined();
  });
});

describe('ensureLanguage / switchLanguage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it("loads a language's catalog when it is missing, then switches to it", async () => {
    i18n.removeResourceBundle('fr', 'translation');
    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(false);
    await switchLanguage('fr');
    expect(i18n.hasResourceBundle('fr', 'translation')).toBe(true);
    expect(i18n.language).toBe('fr');
    expect(i18n.t('player.sleepTimer.fellAsleepNote')).toBe(fr.player.sleepTimer.fellAsleepNote);
  });

  it('applies only the last of two switches', async () => {
    i18n.removeResourceBundle('fr', 'translation');
    const first = switchLanguage('fr');
    const second = switchLanguage('de');
    await Promise.all([first, second]);
    expect(i18n.language).toBe('de');
    expect(i18n.t('player.sleepTimer.fellAsleepNote')).toBe(de.player.sleepTimer.fellAsleepNote);
  });

  it('a switch overtaken by another resolves only once the later one has applied', async () => {
    // The later switch's catalog arrives last (a slower chunk): the first switch's caller
    // (the LanguageProvider, holding the first paint) must not be let go before it.
    const realLoad = catalogs.loadCatalog;
    let releaseDe!: () => void;
    const spy = jest.spyOn(catalogs, 'loadCatalog').mockImplementation(async (code) => {
      if (code === 'de') await new Promise<void>((resolve) => (releaseDe = resolve));
      return realLoad(code);
    });
    try {
      i18n.removeResourceBundle('fr', 'translation');
      i18n.removeResourceBundle('de', 'translation');
      let firstDone = false;
      const first = switchLanguage('fr').then(() => {
        firstDone = true;
      });
      const second = switchLanguage('de');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(firstDone).toBe(false);
      releaseDe();
      await first;
      expect(i18n.language).toBe('de');
      await second;
    } finally {
      spy.mockRestore();
    }
  });

  it('starts with only English in, and requires a language once', async () => {
    i18n.removeResourceBundle('de', 'translation');
    const spy = jest.spyOn(catalogs, 'loadCatalog');
    try {
      await ensureLanguage('en');
      expect(spy).not.toHaveBeenCalled();
      await ensureLanguage('de');
      const before = i18n.getResourceBundle('de', 'translation');
      await ensureLanguage('de');
      expect(spy.mock.calls).toEqual([['de']]);
      expect(i18n.getResourceBundle('de', 'translation')).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});
