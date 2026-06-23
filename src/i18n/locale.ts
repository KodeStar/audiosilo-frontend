import i18next from 'i18next';

/**
 * Active BCP-47 locale for `Intl.*` formatting, read from the i18next singleton.
 * Lives apart from `./index` (which binds react-i18next) so locale-only consumers
 * like `src/lib/format.ts` don't pull React into their dependency graph.
 */
export function getLocale(): string {
  return i18next.language || 'en';
}
