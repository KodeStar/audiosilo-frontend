# UI glyph generator

This folder is an **optional, self-contained dev tool**. It resolves the app's
icons from **FontAwesome Pro** to raw SVG path data and writes the vendored,
committed [`src/components/ui/icon-data.ts`](../../src/components/ui/icon-data.ts).

It is the **only** place AudioSilo touches FontAwesome. The app renders the
vendored paths with `react-native-svg` ([`icon.tsx`](../../src/components/ui/icon.tsx))
and has **no `@fortawesome/*` dependency** - so building, installing, testing, and
shipping the app needs **no FontAwesome Pro token**. Only regenerating the glyphs
(i.e. adding or changing an icon) does.

## Add or change an icon

1. Find the icon on <https://fontawesome.com/icons> (Pro) and note its name +
   weight (light / regular / solid).
2. Add or edit a line in [`manifest.mjs`](manifest.mjs), e.g.
   `['my-icon', 'light', 'faStar']`. The app-facing name (`my-icon`) is what you
   pass to `<Icon name="my-icon" />`; it's also added to the `IconName` type
   automatically.
3. Regenerate (needs your FontAwesome Pro token). Put the token in this folder's
   own gitignored `.env` as `FONTAWESOME_NPM_AUTH_TOKEN=…` (it lives here, not in the
   repo-root `.env`, so the Expo CLI never loads it), then:

   ```sh
   cd scripts/glyphs
   set -a; . ./.env; set +a       # loads FONTAWESOME_NPM_AUTH_TOKEN from scripts/glyphs/.env
   npm install                    # one-time; pulls the Pro packages into ./node_modules (gitignored)
   npm run gen                    # writes ../../src/components/ui/icon-data.ts
   ```

4. Commit the updated `icon-data.ts`. **Do not** commit this folder's `.env`,
   `node_modules`, or `package-lock.json` (all gitignored) - the token is private and
   the install state would re-pin the private registry for everyone.

The generator output is already Prettier-formatted; the repo gate
(`npx tsc --noEmit && npm run lint && npm run format && npm test`) covers it.

## Why

FontAwesome Pro requires a paid token in a private npm registry. Baking it into
the app's `package.json` meant every contributor and CI run needed that token to
`npm install` at all. Vendoring the resolved SVG removes that requirement while
keeping FontAwesome as the design source of truth.
