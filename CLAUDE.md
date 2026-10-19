# AudioSilo Frontend - project guide

The audiobook **player** frontend for **audiosilo-server** (a self-hosted Go
audiobook server at `~/dev/audiosilo/audiosilo-server`). One Expo / React Native codebase
shipping to **web PWA + iOS + Android**. The design system is **Stacks** (the player
redesign): [STYLEGUIDE.md](STYLEGUIDE.md) is authoritative for tokens, type, components and
voice. Screens still carry the layouts ported from the old Nuxt client
(`~/dev/audiosilo-old`) until their redesign phase.

Full roadmap and milestone status: [docs/PLAN.md](docs/PLAN.md). M1–M2 complete;
**M3 (offline downloads)** shipped (`src/downloads/` - `engine.native.ts`/
`engine.web.ts`/`store.ts`, a `(app)/(offline)/downloads` route, and the
`download-control` component); **M4 (PWA / service worker)**
shipped (`public/sw.js`, `public/manifest.json`, `src/lib/register-sw{,.web}.ts`).
Several features have landed since the original plan: **demo mode**, **favourites**,
**self-service password**, and **i18n** (`src/i18n/`). M5 (release/store) is the main
remaining track.

## Model routing (every session follows this)

Work runs through the workspace `/ship` skill (`~/dev/audiosilo/.claude/skills/ship/`):
the main session plans, decides and checks; fresh Opus agents (`ship-implementer`,
`ship-reviewer`, `ship-verifier`) do the reading, writing, reviewing and live
verification, so the large main context is never what reviews or edits code.

## Stack
- **Expo SDK 56**, **React Native 0.85** (new architecture), **React 19**, **Expo Router** (file-based, in `src/app`).
- **Uniwind** (Tailwind v4) for styling - `className` on core RN components, on every platform. No
  `tailwind.config.js`: the theme is CSS in `src/global.css`; colour tokens are generated into it
  from `src/theme/tokens.json` (see Styling below). Replaced NativeWind v4 in player-redesign Phase 0a.
- **TanStack Query** (server state) + **Zustand** (session + player state).
- **Custom native playback module** (`modules/audiosilo-player`, a local Expo
  module): **AVQueuePlayer** on iOS, **Media3/ExoPlayer** on Android. **HTML5 Audio +
  Media Session** on web. (This replaced react-native-track-player - that dep is gone;
  ignore any older doc that still names it.)
- **Icons**: FontAwesome Pro 7 glyphs **vendored as raw SVG** in
  `src/components/ui/icon-data.ts` and drawn with `react-native-svg` - the app has
  **no `@fortawesome/*` dependency** (so no token to build). To add/change an icon,
  edit `scripts/glyphs/manifest.mjs` and regenerate (see `scripts/glyphs/README.md`).
- **expo-secure-store** for the session token (`src/lib/secure-store.ts`; on iOS in an
  after-first-unlock keychain service, so CarPlay can start a book on a locked phone: see Car
  below); **AsyncStorage** for everything else.
- **expo-widgets** for the iOS home screen widget and the sleep timer Live Activity
  (`src/widgets/`, see Widgets below).

## ⚠️ Environment gotchas (read before running)
- **Node 24 required.** RN 0.85 needs ≥20.19.4, and the Expo CLI's env-file loader
  uses `util.parseEnv` (Node ≥20.12) - older Node crashes once a `.env` exists.
  This machine's default `node` (`/usr/local/bin/node`) is old; use nvm's 24:
  `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"` (or set the nvm default).
- **No FontAwesome token needed to build.** Icons are vendored SVG
  (`src/components/ui/icon-data.ts`), so `npm install` pulls nothing private. A
  FontAwesome Pro token (`FONTAWESOME_NPM_AUTH_TOKEN`) is only needed to
  **add/regenerate** an icon via the isolated generator in
  `scripts/glyphs/` (its own `package.json`/`.npmrc`) - see `scripts/glyphs/README.md`.
- **Native runs need a dev build, not Expo Go** (the `audiosilo-player` module, svg,
  secure-store are native): `npx expo prebuild` then `npx expo run:ios` / `run:android`.
  **Editing native code under `modules/audiosilo-player/{ios,android}` requires a full
  rebuild** (`run:ios`/`run:android`) - a Metro/JS reload won't pick it up.
- **iOS build needs TWO Xcode-26 / Expo-56 workarounds (both are load-bearing; a device
  link was verified green with them, red without).** `ios/` is gitignored (CNG), so both
  live in config so `expo prebuild` preserves them - never hand-edit `ios/` for these.
  1. **SwiftUICore autolink (`plugins/withXcode26SwiftUICoreFix.js`).** On the iOS 26 SDK,
     `import SwiftUI` (pulled in transitively by ExpoModulesCore, so effectively every Expo
     module + the generated `ExpoModulesProvider`) makes the compiler emit a direct
     `-framework SwiftUICore` autolink. Xcode 26's linker rejects it (`cannot link directly
     with 'SwiftUICore' ... not an allowed client` -> `ld` error 65) because the app isn't on
     `SwiftUICore.tbd`'s `allowable_clients` list - and it rejects BOTH the implicit autolink
     and an explicit `-weak_framework` (don't reach for weak-linking; it doesn't work). The
     plugin instead **suppresses** the autolink with `-disable-autolink-framework SwiftUICore`
     (`-Xfrontend`) on the app target *and* every pod (a Podfile `post_install` loop), so the
     symbols resolve through SwiftUI's re-export (SwiftUI *is* an allowed client). It also
     sets `ENABLE_DEBUG_DYLIB = NO` (Xcode 26's Debug `AudioSilo.debug.dylib` hits the same
     wall; RN doesn't use SwiftUI previews).
  2. **Build React Native from source (`expo-build-properties` -> `ios.buildReactNativeFromSource: true`).**
     Expo 56 defaults to a **prebuilt** React core (`RCT_USE_PREBUILT_RNCORE`), but that
     prebuilt `React.xcframework` doesn't export the Fabric renderer symbols
     (`facebook::react::Props`/`BaseViewProps`/`YogaStylableProps`/`Sealable`/`DebugStringConvertible`)
     that source-built `RNSVG`/`RNScreens`/`RNGestureHandler` link against -> undefined-symbol
     `ld` failure. Building RN from source restores the exported symbols. `pod install` then
     also builds Expo modules from source (precompiled modules require the prebuilt core), so
     builds are slower but correct. Do not re-enable the prebuilt core without confirming the
     Fabric symbols are exported.
- **The Android window does not resize for the keyboard** (edge to edge, SDK 56): an overlay or a
  bottom-anchored panel must lift itself (`useKeyboardAvoidance`, Styling below), and only a device
  run shows it; neither jest nor the web build has a software keyboard.
- **Web dev needs CORS**: set `cors_origins` in the server config to the web origin
  (e.g. `http://localhost:8081`), or serve same-origin. Self-signed TLS may need
  trusting / `tls.mode: autocert`.
- Run tool commands from the **repo root** (a stray `cd` into `node_modules`
  persists between Bash calls and breaks Expo's config resolution).

## Commands
```sh
npm run web                 # expo start --web (testable without a dev build)
npm run ios / npm run android
npx tsc --noEmit            # typecheck (strict; must stay clean)
npm run lint                # eslint flat config (eslint-config-expo + prettier)
npm test                    # colour-token drift + generator tests + style guards (scripts/check-styles.cjs), then jest-expo (npm test -- --coverage for coverage)
npm run format              # prettier --check . (CI-gated; fails on unformatted files)
npx prettier --write .      # auto-fix formatting locally before committing
npx expo export -p web      # bundle smoke test (run after meaningful changes)
npm run gen:tokens          # regenerate colour tokens after editing src/theme/tokens.json
```

**Before a change is done, run `npx tsc --noEmit && npm run lint && npm run format && npm test`**
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) gates all four (typecheck,
lint, **prettier `--check`** via the `format` script, test) on every PR/push.
`.nvmrc` pins Node `24.16.0`,
which CI reads via `node-version-file`; keep the lockfile committed in sync (regenerate
with `npm install` after changing deps).

> Before adding code, read the workspace **[CODE-HEALTH.md](../CODE-HEALTH.md)** -
> Definition of Done + the recurring drift patterns (wire-contract drift, dead
> exports, stale docs, untested modules) a full review found. Especially: change
> the wire format → change **both** repos **and** add a test on both sides.

## Documentation

The product docs live in [`../audiosilo-docs`](../audiosilo-docs/) (Docusaurus:
User Guide + Developer Docs, generated screenshots). **Updating them is part of
Definition of Done**: a change here that touches player behaviour, screens/
strings, or the wire contract updates the affected pages in the same logical
change - for this repo that's chiefly `docs-users/listening/**` and
`docs-developers/frontend/**`, plus regenerated `web-player/` screenshots
(`audiosilo-docs/screenshots/run.sh`) when the UI changes. Mapping table:
`audiosilo-docs/docs-developers/contributing/documentation.md`. Docs gate:
`npm run build` in audiosilo-docs.

## Reference: CONVENTIONS.md (read on demand)

These topics live in [CONVENTIONS.md](CONVENTIONS.md), not here, to keep this file small.
**Before changing code a topic below covers, read its entry** (`grep -n '<topic>'
CONVENTIONS.md`, then Read that range). When you add or change a rule, edit it there and
keep this index in step (one line per topic).

- **Architecture & conventions**
  - `AUTH_STORAGE_VERSION`
  - `CACHE_STORAGE_VERSION`
  - `mayActFor(cid)`
  - Routes carrying `?connection=`
  - Nobody chosen
  - Switching
  - The PIN's authority is the secure store
  - A document that can't be read
  - Wire
  - Refusals
  - Naming the owner
  - Signing a member in here
  - Kids
  - The Household page
  - Wire
  - Hooks
  - The gate
  - Surfaces
  - Player modules registry
  - Capability keys are open
  - Slots
  - The module's surface
  - Remote moves vs the resume floor
  - The iOS engine is split into files
  - Android: a `MediaLibraryService` with chapter controls (Audible parity)
  - Smart speed and Voice boost
  - The download hot-swap plays on from intent, not from `playing`
  - Downloads store absolute file URIs
  - Stream the file, not the book
  - Whole-book timeline
  - Start playback only after chapters/files have loaded
  - Never navigate while the app is in the background
  - Never restart an in-progress book from 0
  - A loaded book picks up another device's place
  - Stall → error watchdog lives in shared JS
  - Why not interpret engine events
  - A browser autoplay refusal is a pause, not an error
  - The web engine's file advance is not a pause
  - JS decides what the car lists
  - `car-controller.ts`
  - `src/playback/book-source.ts`
  - Auto sleep stays off in the car
  - Android Auto
  - CarPlay and the UIScene life cycle
  - Tokens on a locked phone
  - A route, not a second player (decision 7)
  - The receiver never gets the session token
  - Generations
  - Foreign media
  - Transcoded streams
  - Primitives are react-native-reusables
  - The keyboard over a bottom-anchored overlay
  - Web keyboard (Space)
  - Colour tokens are the Stacks semantic tokens, with ONE source, `src/theme/tokens.json`
  - Fonts (Stacks)
  - `<Text>` variants are the Stacks type roles
  - rem is 14px on native
  - Theme
  - Conflicting classes are not de-duplicated
  - Web cascade layers
  - `className` only works on React Native's own components
  - Native shadows
  - The pushing tab owns a detail page
  - Cold deep link owner = Home
  - Tab presses from our chrome dispatch `JUMP_TO`
  - Web: `<TabSlot/>` stays at a FIXED ancestor path at every width
  - The You hub is the Me tab's ROOT
  - Settings is a page of the array group
  - A tab page's scroller is `TabPageScroll`
  - Every page names the browser tab (web)
  - Keep the next books ready
  - The session decline mark
  - One choke point
  - Kept files
  - Web
  - Changed chapters
  - Offline companion
  - Full player
  - Previously on
  - Command palette (web only)
  - Up next
  - Search
  - Profile menu
  - Toasts
  - Banners

## Layout
```
src/app/            Expo Router routes ((app) tab groups, connect/, player + finished modals)
src/api/            client.ts, types.ts, hooks.ts (React Query), provider.tsx
src/playback/       PlaybackService + web/native engines, store, book-queue, book-source, progress-sync, effects, time-saved
src/car/            CarPlay + Android Auto JS: snapshot model, car sync controller, headless task, native seam
src/cast/           Chromecast: the routed service, the cast engine, cast tokens, native + web drivers
src/widgets/        iOS widget + sleep timer Live Activity ('widget' functions, model, sync)
src/downloads/      offline downloads: native/web engines + store (sibling of playback)
src/modules/        player modules (Bridge Phase 2a): the registry (empty) + the slot wrapper; NOT the root modules/
src/components/      ui/ (primitives + Icon), shell/ (tabs, top bar, dock, headers, palette), layout/ (banners, ContentScope), player/, book/ (the book page), annotations/ (bookmark + note rows, editors), journal/, you/ (the You hub: stats/, year/), settings/ (Settings panes), account/ (the account page), connect/ (onboarding), library/ (covers, Library modes, book actions), home/, series/ (series + people pages), search/, upnext/, downloads/, profiles/ (people, PIN, Household), kids/ (kids mode), house/ (listening in the house)
src/stores/         Zustand: session, profiles, search, settings, series-orderings, library-selection
src/i18n/           i18next setup, language provider, locale JSONs (locales/)
src/theme/          tokens (tokens.json source -> generated tokens.ts) + ThemeProvider
src/lib/            storage (+ storage-keys), secure-store, bootstrap (launch steps), storage + identity migrations, connection-id, profile-pin, sha256, native-intent, device, paths, format, register-sw
modules/audiosilo-player/   the native playback module (ios/ Swift, android/ Kotlin, src/ its TS surface)
plugins/            config plugins: withCast, withCarPlay, withWidgetsNoPush, withXcode26SwiftUICoreFix
index.ts            app entry: registers the car task, then expo-router/entry
```

@AGENTS.md
