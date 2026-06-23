import * as Localization from 'expo-localization';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { getItem, setItem } from '@/lib/storage';

import i18n, { FALLBACK_CODE, isSupportedCode, type SupportedCode } from './index';

/** `'system'` follows the device language; a code pins a specific UI language. */
export type LanguagePref = 'system' | SupportedCode;

const STORAGE_KEY = 'audiosilo.language';

/** Best supported match for the device's preferred languages, else the fallback. */
function detectDeviceLanguage(): SupportedCode {
  for (const locale of Localization.getLocales()) {
    if (isSupportedCode(locale.languageCode)) return locale.languageCode;
  }
  return FALLBACK_CODE;
}

/** Resolve a preference to the concrete language to load. */
export function resolveLanguage(pref: LanguagePref): SupportedCode {
  return pref === 'system' ? detectDeviceLanguage() : pref;
}

type LanguageContextValue = {
  /** User preference, including `'system'`. */
  pref: LanguagePref;
  /** Concrete language actually in effect (never `'system'`). */
  language: SupportedCode;
  setPref: (p: LanguagePref) => void;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * Restores the persisted language preference (default: follow the device) and
 * applies it to i18next before first paint — gating render until resolved, like
 * {@link ThemeProvider}, so the UI never flashes the wrong language.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LanguagePref>('system');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    void getItem<LanguagePref>(STORAGE_KEY).then(async (saved) => {
      const next: LanguagePref = saved === 'system' || isSupportedCode(saved) ? saved : 'system';
      await i18n.changeLanguage(resolveLanguage(next));
      if (!active) return;
      setPrefState(next);
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const setPref = (p: LanguagePref) => {
    setPrefState(p);
    void i18n.changeLanguage(resolveLanguage(p));
    void setItem(STORAGE_KEY, p);
  };

  if (!hydrated) return null;

  return (
    <LanguageContext.Provider value={{ pref, language: resolveLanguage(pref), setPref }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
