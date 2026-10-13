import type { CastButtonProps } from './cast-button-parts';

// Fallback used only for type resolution. Metro substitutes cast-button.native.tsx on
// iOS/Android and cast-button.web.tsx on the web.
export function CastButton(_props: CastButtonProps): null {
  return null;
}
