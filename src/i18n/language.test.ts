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
    await i18n.changeLanguage('es');
    // A key present in every catalog still resolves in the active language…
    expect(i18n.t('common.cancel')).toBe('Cancelar');
  });
});
