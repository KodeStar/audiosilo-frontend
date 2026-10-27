import i18n, { ensureLanguage, SUPPORTED_CODES, switchLanguage } from '@/i18n';

import * as catalogs from './catalogs';
import { BUNDLED_CATALOGS as WEB_BUNDLED, CATALOG_LOADERS, loadCatalog } from './catalogs.web';
import de from './locales/de.json';
import fr from './locales/fr.json';

describe('catalogs', () => {
  it('bundles every language on native (the tests run as native), only English on the web', () => {
    for (const code of SUPPORTED_CODES) {
      expect(i18n.hasResourceBundle(code, 'translation')).toBe(true);
    }
    expect(Object.keys(WEB_BUNDLED)).toEqual(['en']);
  });

  it('the web has a chunk for every other language', () => {
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual(
      SUPPORTED_CODES.filter((c) => c !== 'en').sort(),
    );
  });

  it('the web loads a catalog from its chunk, English from the bundle', async () => {
    // jest runs no dynamic import(): the chunks stand in as loaders.
    const loaders = { fr: () => Promise.resolve({ default: fr }) };
    expect(await loadCatalog('fr', loaders)).toBe(fr);
    expect(await loadCatalog('en', loaders)).toBe(WEB_BUNDLED.en);
    expect(await loadCatalog('xx', loaders)).toBeUndefined();
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

  it('keeps a bundled catalog as it is', async () => {
    const before = i18n.getResourceBundle('de', 'translation');
    await ensureLanguage('de');
    expect(i18n.getResourceBundle('de', 'translation')).toBe(before);
  });
});
