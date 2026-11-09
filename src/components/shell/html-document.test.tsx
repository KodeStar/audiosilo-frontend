import type { ReactElement } from 'react';

// react-dom ships no types here (the app has no @types/react-dom), so typed by hand.
const { renderToStaticMarkup } = jest.requireActual<{
  renderToStaticMarkup: (element: ReactElement) => string;
}>('react-dom/server');

// The static web document (`src/app/+html.tsx`) with the router's own parts as expo-router
// 58 hands them over (`useServerDocumentContext`): left out, the bundle's scripts never load
// and the page never hydrates.
let mockDocument: Record<string, unknown> = {};
jest.mock('expo-router/html', () => ({
  ScrollViewStyleReset: () => null,
  useServerDocumentContext: () => mockDocument,
}));

/* eslint-disable import/first */
import Root from '@/app/+html';
/* eslint-enable import/first */

const render = () =>
  renderToStaticMarkup(
    <Root>
      <div id="root">app</div>
    </Root>,
  );

it("puts the router's head nodes last in <head> and its body nodes after the app", () => {
  mockDocument = {
    headNodes: <link rel="stylesheet" href="/web/app.css" />,
    bodyNodes: <script src="/web/entry.js" defer />,
  };
  const html = render();
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  // The cascade-layer order still precedes the router's stylesheets.
  expect(head.indexOf('@layer')).toBeGreaterThan(0);
  expect(head.indexOf('href="/web/app.css"')).toBeGreaterThan(head.indexOf('@layer'));
  // Last: after our own styles (the backdrop is the last of them).
  expect(head.indexOf('href="/web/app.css"')).toBeGreaterThan(head.lastIndexOf('<style'));
  const body = html.slice(html.indexOf('<body'));
  expect(body.indexOf('<script src="/web/entry.js"')).toBeGreaterThan(
    body.indexOf('<div id="root">app</div>'),
  );
});

it("spreads the router's <html> and <body> attributes, keeping lang unless it sets one", () => {
  mockDocument = { bodyAttributes: { className: 'b' } };
  expect(render()).toMatch(/<html lang="en">/);
  expect(render()).toMatch(/<body class="b">/);
  mockDocument = { htmlAttributes: { lang: 'de', dir: 'ltr' } };
  expect(render()).toMatch(/<html lang="de" dir="ltr">/);
});
