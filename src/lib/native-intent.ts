/** The app's own URL scheme (`app.json` `scheme`), as links into the app carry it. */
const APP_LINK = 'audiosilo://';

/**
 * A link into the app (`audiosilo://player?...` from the iOS widget and Live Activity, the
 * pairing link `audiosilo://connect?...`) as the path Expo Router should open, its query
 * exactly as the link encoded it. Expo Router turns an app-scheme URL into a path by decoding
 * each query value and joining them back UNENCODED before it parses them again, so a value
 * holding `&`, `#`, `+` or `%XX` came apart: a book in "Austen/Pride & Prejudice" opened the
 * player on "Austen/Pride " (no such book: a spinner that never ends). A path (`/player?...`)
 * is taken as it is and decoded once, like an in-app href. Anything else (the development
 * client's own links, another scheme) is left as it is.
 */
export function appLinkPath(url: string): string {
  if (url.slice(0, APP_LINK.length).toLowerCase() !== APP_LINK) return url;
  const rest = url.slice(APP_LINK.length);
  if (rest.toLowerCase().startsWith('expo-development-client')) return url;
  return '/' + rest.replace(/^\/+/, '');
}
