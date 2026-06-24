import i18n, { isSupportedCode } from '@/i18n';

const mockGetLocales = jest.fn();
jest.mock('expo-localization', () => ({ getLocales: () => mockGetLocales() }));

// Imported after the mock var + jest.mock so the factory closes over `mockGetLocales`
// without a TDZ error; the import order is deliberate.
// eslint-disable-next-line import/first
import { resolveLanguage } from '@/i18n/language-provider';

describe('isSupportedCode', () => {
  it('accepts known codes and rejects others', () => {
    expect(isSupportedCode('es')).toBe(true);
    expect(isSupportedCode('en')).toBe(true);
    expect(isSupportedCode('xx')).toBe(false);
    expect(isSupportedCode(null)).toBe(false);
    expect(isSupportedCode(undefined)).toBe(false);
  });
});

describe('resolveLanguage', () => {
  it('returns an explicit pref unchanged', () => {
    expect(resolveLanguage('de')).toBe('de');
  });

  it('follows the device language when supported', () => {
    mockGetLocales.mockReturnValue([{ languageCode: 'fr' }]);
    expect(resolveLanguage('system')).toBe('fr');
  });

  it('falls back to English for an unsupported device language', () => {
    mockGetLocales.mockReturnValue([{ languageCode: 'ja' }, { languageCode: 'zh' }]);
    expect(resolveLanguage('system')).toBe('en');
  });

  it('picks the first supported device language in preference order', () => {
    mockGetLocales.mockReturnValue([{ languageCode: 'ja' }, { languageCode: 'it' }]);
    expect(resolveLanguage('system')).toBe('it');
  });
});

describe('catalog switching', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('resolves translated strings per active language', async () => {
    expect(i18n.t('settings.title')).toBe('Settings');
    await i18n.changeLanguage('es');
    expect(i18n.t('settings.title')).toBe('Ajustes');
  });

  it('falls back to English for keys missing in a partial catalog', async () => {
    // The shipped catalogs are all complete, so to exercise the fallback we register
    // a deliberately *partial* throwaway locale that defines one key (settings.title)
    // but omits another (common.cancel). `supportedLngs` is widened at runtime so
    // i18next will actually activate the throwaway locale (it filters unknown codes).
    const prevSupported = i18n.options.supportedLngs;
    i18n.options.supportedLngs = [...(prevSupported || []), 'zz'];
    i18n.addResourceBundle('zz', 'translation', { settings: { title: 'Zz Settings' } });
    try {
      await i18n.changeLanguage('zz');
      expect(i18n.language).toBe('zz');

      // The partial catalog genuinely lacks the key (so the result below can only
      // come from the English fallback, not the active locale).
      const bundle = i18n.getResourceBundle('zz', 'translation') as Record<string, unknown>;
      expect(bundle).toHaveProperty('settings');
      expect(bundle).not.toHaveProperty('common');

      // Missing in `zz` → resolves to the English source string, not the raw key.
      // (English: common.cancel === 'Cancel'.)
      expect(i18n.t('common.cancel')).toBe('Cancel');
    } finally {
      i18n.removeResourceBundle('zz', 'translation');
      i18n.options.supportedLngs = prevSupported;
    }
  });
});
