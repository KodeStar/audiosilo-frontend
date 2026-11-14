/** The browser's "more contrast" preference (Windows contrast themes, macOS Increase
 * contrast, or a browser's own setting); react-native-web's AccessibilityInfo has no
 * contrast reads. Native: `os-contrast.ts`. */
const QUERY = '(prefers-contrast: more)';

const media = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY)
    : null;

export function readOsHighContrast(): Promise<boolean> {
  return Promise.resolve(media()?.matches === true);
}

export function watchOsHighContrast(onChange: (on: boolean) => void): () => void {
  const mql = media();
  if (!mql) return () => undefined;
  const listener = (e: MediaQueryListEvent) => onChange(e.matches);
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}
