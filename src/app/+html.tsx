import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { BASE_URL as BASE } from '@/lib/base-url';
import { colors } from '@/theme/tokens';

// Customises the static HTML shell Expo emits for every web route. This is where
// the PWA install metadata and favicon live. Links use absolute, base-prefixed
// hrefs so they resolve from nested routes too — empty base in dev (served at root),
// "/web" in the production export (see base-url.ts).

// Paint the document backdrop dark (the dark-mode-first default) before React
// mounts, so there's no white flash on first paint, no white in the iOS PWA
// home-indicator gap, and no white frame during the browser back-swipe. #root is
// included because react-native-web can size its root container to innerHeight
// (short of the full screen in a standalone PWA), leaving a strip the backdrop
// must cover. The live theme keeps these in sync at runtime (see ThemeProvider's
// web effect), which also covers the light-theme case.
const backdropCss = `html, body, #root { background-color: ${colors.dark.bg}; }`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        <meta name="description" content="Your self-hosted audiobook player." />

        {/* PWA install + theming */}
        <link rel="manifest" href={`${BASE}/manifest.json`} />
        <meta name="theme-color" content="#db2777" />
        <link rel="icon" type="image/svg+xml" href={`${BASE}/favicon.svg`} />
        <link rel="apple-touch-icon" href={`${BASE}/icons/icon-192.png`} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="AudioSilo" />

        {/* Disable body scrolling on web so ScrollView works like on native. */}
        <ScrollViewStyleReset />

        {/* Backdrop behind the app, to avoid a white flash before/around React. */}
        <style dangerouslySetInnerHTML={{ __html: backdropCss }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
