import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

import { BASE_URL as BASE } from '@/lib/base-url';
import { colors } from '@/theme/tokens';

// Customises the static HTML shell Expo emits for every web route. This is where
// the PWA install metadata and favicon live. Links use absolute, base-prefixed
// hrefs so they resolve from nested routes too - empty base in dev (served at root),
// "/web" in the production export (see base-url.ts).

// Paint the document backdrop in the OS colour scheme's background before React
// mounts (a new install follows the system theme; see defaultSchemePref), so there's no
// flash of the wrong colour on first paint, no white in the iOS PWA home-indicator gap,
// and no white frame during the browser back-swipe. #root is included because
// react-native-web can size its root container to innerHeight (short of the full
// screen in a standalone PWA), leaving a strip the backdrop must cover. The live theme
// keeps these in sync at runtime (see ThemeProvider's web effect), which also covers an
// explicit light/dark pick that differs from the OS.
const backdropCss = [
  `html, body, #root { background-color: ${colors.light.background}; }`,
  `@media (prefers-color-scheme: dark) { html, body, #root { background-color: ${colors.dark.background}; } }`,
].join('\n');

// Cascade-layer order for Uniwind (Tailwind v4) + react-native-web. Tailwind v4 ships
// in layers (preflight in `base`, classes in `utilities`), and Uniwind moves RNW's
// element resets (e.g. a View's `border: 0 solid black`, a Text's 14px system font)
// into a `rnw` layer. Layer precedence follows the order layers are FIRST named, and
// RNW's stylesheet sits above the Tailwind <link> in <head>, so without this `rnw`
// would rank lowest and Tailwind's preflight would override RNW's resets - unlike
// NativeWind (Tailwind v3), whose unlayered preflight lost to them. Naming the order
// here, before either stylesheet, restores that: preflight < RNW resets < classes.
const layerOrderCss = '@layer properties, theme, base, rnw, components, utilities;';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* Must precede every stylesheet - see layerOrderCss. */}
        <style dangerouslySetInnerHTML={{ __html: layerOrderCss }} />
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
