import type { ImageSource } from 'expo-image';
import { type CSSProperties, useState } from 'react';
import { StyleSheet } from 'react-native';

import { corsModeFor } from '@/lib/cors-mode';
import { pageLocation } from '@/lib/same-origin';

import type { CoverImageProps } from './cover-image';

/** The URI of an expo-image style `source` (a string, `{ uri }`, or the first of a list). */
function uriOf(source: CoverImageProps['source']): string | undefined {
  if (!source) return undefined;
  if (typeof source === 'string') return source;
  if (typeof source === 'number') return undefined; // a bundled asset: covers are never one
  const first = (Array.isArray(source) ? source[0] : source) as ImageSource | string | undefined;
  return typeof first === 'string' ? first : (first?.uri ?? undefined);
}

/**
 * Web: the cover as a plain `<img>`, absolutely filling its box like expo-image's web
 * image, with `crossOrigin="anonymous"` when its server is another origin than the page
 * (`corsModeFor`), so a player served elsewhere loads it in CORS mode, which the server's
 * `cors_origins` grant (and its `Cross-Origin-Resource-Policy` no longer matters). Same
 * origin, `blob:` and `data:` images take no attribute, as before.
 *
 * Decoded off the main thread and loaded lazily, except a `priority="high"` cover (one
 * on the first screen), which is fetched at once and ahead of the page's other images.
 * Hidden until loaded; one that arrives later than `FADE_AFTER_MS` after it was drawn
 * fades in over `transition` ms, one that arrives sooner (the browser's cache, a fast
 * server) shows at once, so a reload's first covers are on screen the moment they load.
 * Keyed by its URI, so a recycled row's new cover starts hidden again. `source.headers` are not
 * sent: every server image URL carries the media token (`?token=`), and an `<img>` can't
 * send headers anyway. `blurRadius` and `recyclingKey` are native concerns (the backdrop
 * blurs with a CSS filter on the web).
 */
/** A cover that loads within this long of being drawn shows without the fade. */
export const FADE_AFTER_MS = 120;

export function CoverImage({ source, ...rest }: CoverImageProps) {
  const uri = uriOf(source);
  return uri ? <CoverImg key={uri} uri={uri} {...rest} /> : null;
}

/** One URI's `<img>` (see `CoverImage`). */
function CoverImg({
  uri,
  style,
  contentFit = 'cover',
  transition,
  onError,
  priority,
  testID,
}: Omit<CoverImageProps, 'source'> & { uri: string }) {
  // How it came in: not yet, at once (within FADE_AFTER_MS) or late (fading in).
  const [loaded, setLoaded] = useState<'no' | 'fast' | 'late'>('no');
  // Keyed by its URI, so one answer (and one start time) for the element's life.
  const [crossOrigin] = useState(() => corsModeFor(uri, pageLocation()));
  const [drawnAt] = useState(() => Date.now());
  const fade = typeof transition === 'number' ? transition : (transition?.duration ?? 0);
  const css: CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: contentFit,
    ...(StyleSheet.flatten(style) as CSSProperties),
    opacity: fade > 0 && loaded === 'no' ? 0 : 1,
    transition: fade > 0 && loaded !== 'fast' ? `opacity ${fade}ms ease-out` : undefined,
  };
  const high = priority === 'high';
  return (
    <img
      src={uri}
      alt=""
      crossOrigin={crossOrigin}
      loading={high ? 'eager' : 'lazy'}
      fetchPriority={high ? 'high' : undefined}
      decoding="async"
      data-testid={testID}
      style={css}
      onLoad={(e) => {
        const fast = Date.now() - drawnAt < FADE_AFTER_MS;
        // Shown now, not at React's next render (which a busy page can hold back).
        if (fade > 0) {
          if (fast) e.currentTarget.style.transition = '';
          e.currentTarget.style.opacity = '1';
        }
        setLoaded(fast ? 'fast' : 'late');
      }}
      // expo-image's onError takes an event; the app's callers read none of it.
      onError={() => onError?.({ error: `failed to load ${uri}` })}
    />
  );
}
