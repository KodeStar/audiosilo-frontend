import { getLocales } from 'expo-localization';

/** The country a directory search sends to iTunes: the device locale's region when it
 * is two letters A-Z, else undefined (the server's default, US). Never the server's
 * `metadata.region`, and never sent to Podcast Index (`searchPodcastDirectory`). */
export function deviceCountry(): string | undefined {
  try {
    const region = getLocales()[0]?.regionCode ?? '';
    return /^[A-Z]{2}$/.test(region) ? region : undefined;
  } catch {
    return undefined;
  }
}
