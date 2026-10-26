import { Image, type ImageProps } from 'expo-image';

/** What the app's cover images ask of an image: a source, a size, cover fit, a fade in
 * and a failure callback. `cover-image.web.tsx` draws the same props as a plain `<img>`. */
export type CoverImageProps = Pick<
  ImageProps,
  | 'source'
  | 'style'
  | 'contentFit'
  | 'transition'
  | 'recyclingKey'
  | 'blurRadius'
  | 'onError'
  | 'testID'
>;

/**
 * A cover, artwork or backdrop image from a server. Native: expo-image, as before (its
 * disk cache, headers on the source, `blurRadius`). The web build draws a plain `<img>`
 * instead (`cover-image.web.tsx`), which can load a cross-origin server's image in CORS
 * mode; expo-image's web `<img>` takes no `crossOrigin`.
 */
export function CoverImage(props: CoverImageProps) {
  return <Image {...props} />;
}
