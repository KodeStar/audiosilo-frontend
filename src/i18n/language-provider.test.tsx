import { act, render, waitFor } from '@testing-library/react-native';

import { getItem, setItem } from '@/lib/storage';

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));

// eslint-disable-next-line import/first
import i18n from './index';
// eslint-disable-next-line import/first
import { LanguageProvider, useLanguage } from './language-provider';

const STORAGE_KEY = 'audiosilo.language';

type LangValue = ReturnType<typeof useLanguage>;

/** Capture the live context value so async assertions can poll it. The provider
 * gates render on hydration, so this probe only runs once hydration resolves. */
function Probe({ onValue }: { onValue: (v: LangValue) => void }) {
  onValue(useLanguage());
  return null;
}

/** RNTL 14's render is async: awaiting it keeps the provider's hydration inside act. */
async function mountProvider() {
  let latest: LangValue | null = null;
  await render(
    <LanguageProvider>
      <Probe onValue={(v) => (latest = v)} />
    </LanguageProvider>,
  );
  return () => latest;
}

afterEach(async () => {
  await setItem(STORAGE_KEY, 'system');
  await i18n.changeLanguage('en');
});

describe('LanguageProvider', () => {
  it('coerces an invalid persisted pref to "system"', async () => {
    await setItem(STORAGE_KEY, 'not-a-language');
    const value = await mountProvider();

    await waitFor(() => expect(value()).toBeTruthy());
    expect(value()!.pref).toBe('system');
  });

  it('loads and applies a valid persisted pref', async () => {
    await setItem(STORAGE_KEY, 'de');
    const value = await mountProvider();

    await waitFor(() => expect(value()).toBeTruthy());
    expect(value()!.pref).toBe('de');
    expect(value()!.language).toBe('de');
  });

  it('persists a pref change via setPref', async () => {
    const value = await mountProvider();
    await waitFor(() => expect(value()).toBeTruthy());

    await act(async () => {
      value()!.setPref('es');
    });

    await waitFor(() => expect(value()!.pref).toBe('es'));
    expect(await getItem<string>(STORAGE_KEY)).toBe('es');
  });
});
