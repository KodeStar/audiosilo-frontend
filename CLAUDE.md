# AudioSilo Frontend — project guide

The audiobook **player** frontend for **audiosilo-server** (a self-hosted Go
audiobook server at `~/dev/audiosilo/audiosilo-server`). One Expo / React Native codebase
shipping to **web PWA + iOS + Android**. Design is ported from the old Nuxt
client at `~/dev/audiosilo-old` (pink-accented, Roboto, dark-mode-first).

Full roadmap and milestone status: [docs/PLAN.md](docs/PLAN.md). M1–M2 complete;
**M3 (offline downloads)** shipped (`src/downloads/` — `engine.native.ts`/
`engine.web.ts`/`store.ts`, a `(app)/downloads` route, and the
`download-control`/`download-badge` components); **M4 (PWA / service worker)**
shipped (`public/sw.js`, `public/manifest.json`, `src/lib/register-sw{,.web}.ts`).
Several features have landed since the original plan: **demo mode**, **favourites**,
**self-service recovery**, and **i18n** (`src/i18n/`). M5 (release/store) is the main
remaining track.

## Stack
- **Expo SDK 56**, **React Native 0.85** (new architecture), **React 19**, **Expo Router** (file-based, in `src/app`).
- **NativeWind v4** (Tailwind v3.4 engine) for styling. Tokens in `tailwind.config.js`, directives in `src/global.css`.
- **TanStack Query** (server state) + **Zustand** (session + player state).
- **Custom native playback module** (`modules/audiosilo-player`, a local Expo
  module): **AVQueuePlayer** on iOS, **Media3/ExoPlayer** on Android. **HTML5 Audio +
  Media Session** on web. (This replaced react-native-track-player — that dep is gone;
  ignore any older doc that still names it.)
- **FontAwesome Pro 7** icons via `@fortawesome/react-native-fontawesome` + `react-native-svg`.
- **expo-secure-store** for the session token; **AsyncStorage** for everything else.

## ⚠️ Environment gotchas (read before running)
- **Node 24 required.** RN 0.85 needs ≥20.19.4, and the Expo CLI's env-file loader
  uses `util.parseEnv` (Node ≥20.12) — older Node crashes once a `.env` exists.
  This machine's default `node` (`/usr/local/bin/node`) is old; use nvm's 24:
  `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"` (or set the nvm default).
- **FontAwesome Pro token** lives in a gitignored **`.env`** as
  `FONTAWESOME_NPM_AUTH_TOKEN=...`; `.npmrc` references it. To (re)install any
  `@fortawesome/*` package the token must be in the process env:
  `set -a; . ./.env; set +a; npm install …`.
- **Native runs need a dev build, not Expo Go** (the `audiosilo-player` module, svg,
  secure-store are native): `npx expo prebuild` then `npx expo run:ios` / `run:android`.
  **Editing native code under `modules/audiosilo-player/{ios,android}` requires a full
  rebuild** (`run:ios`/`run:android`) — a Metro/JS reload won't pick it up.
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
npm test                    # jest-expo unit tests (npm test -- --coverage for coverage)
npm run format              # prettier --check . (CI-gated; fails on unformatted files)
npx prettier --write .      # auto-fix formatting locally before committing
npx expo export -p web      # bundle smoke test (run after meaningful changes)
```

**Before a change is done, run `npx tsc --noEmit && npm run lint && npm run format && npm test`**
— CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) gates all four (typecheck,
lint, **prettier `--check`** via the `format` script, test) on every PR/push (its
`npm ci` needs the `FONTAWESOME_NPM_AUTH_TOKEN` secret). `.nvmrc` pins Node `24.16.0`,
which CI reads via `node-version-file`; keep the lockfile committed in sync (regenerate
with `npm install` after changing deps).

> Before adding code, read the workspace **[CODE-HEALTH.md](../CODE-HEALTH.md)** —
> Definition of Done + the recurring drift patterns (wire-contract drift, dead
> exports, stale docs, untested modules) a full review found. Especially: change
> the wire format → change **both** repos **and** add a test on both sides.

## Architecture & conventions

**Path is identity.** All content is addressed by `(library_id, rel_path)`, never
a DB id. Every content call passes `?path=<rel_path>`; persist client state keyed
by `(library_id, path)`. See `src/api/client.ts` + `src/api/types.ts`.

**API envelopes** (from the Go handlers): auth returns `{ token, user }`; `/me`
returns the user directly; lists are wrapped (`{ libraries }`, `{ books, next_cursor }`,
`{ progress }`, `{ bookmarks }`, `{ notes }`); errors are `{ error }`. Pairing deep
link is `audiosilo://connect?server=<base>&token=<pairing_token>`.

**Self-service recovery.** `User` carries `has_password`/`has_recovery`. A signed-in
user can set a password (`client.setPassword`) and/or mint a durable **recovery code**
(`client.generateRecoveryCode`) from Settings so they can get back in after signing out
without an admin. A recovery code is just an auth code the user owns — it redeems through
the same `redeemCode → exchange` path as an invite, so the connect screen's code field
accepts either. Sign-out is guarded (`src/lib/recovery.ts` `needsRecoveryWarning`):
a user with neither credential is warned and offered a recovery code before their only
way in is revoked (`src/components/account/sign-out-confirm.tsx`).

**Media auth differs by platform** (`src/api/client.ts` `mediaTokenQuery`): web
embeds `?token=` in cover/stream URLs (`<img>`/`<audio>` can't set headers);
native passes `Authorization` headers. **This depends on a server change** in
`audiosilo-server` `internal/api/middleware.go` — `bearerToken` falls back to a
`token` query param for media GETs.

**Playback (`src/playback/`)** — the fiddly part:
- `PlaybackService` interface (`types.ts`). Metro resolves the engine per platform:
  `service.web.ts` (HTML5 + Media Session) / `service.native.ts`, which is a thin
  bridge to the **custom native module** `modules/audiosilo-player` (AVQueuePlayer on
  iOS, Media3/ExoPlayer on Android — that module owns the audio session, background
  audio, lock-screen/remote commands, gapless multi-file playback, and pitch-corrected
  speed). `service.ts` is a throwing fallback for tsc only. (There is **no**
  `register.native.ts` and no react-native-track-player — both are gone; the native
  module registers its own background service.)
- **The native module is where the OS-integration bugs live**, and it can only be
  validated by a device rebuild. Known iOS gotchas now handled in
  `AudiosiloPlayerModule.swift` (read its comments before touching it):
  - **Seek before ready.** Seeking a freshly-created `AVPlayerItem` before it reaches
    `.readyToPlay` is silently dropped (esp. streaming) — this made resume start from
    0. The resume/skip start position is **deferred** until `.readyToPlay`
    (`pendingSeek`/`applyPendingSeek`), with play gated (`wantsPlay`) so audio never
    briefly starts at 0. Android doesn't have this — Media3's `setMediaItems(items,
    startIndex, startPositionMs)` honors the start natively.
  - **Now Playing focus / "pause needs two presses".** `MPNowPlayingInfoCenter.
    playbackState` must be kept in sync (`syncPlaybackState`); leaving it `.unknown`
    makes iOS spend the first remote/earbud press claiming now-playing focus.
  - **Interruption auto-resume.** Only resume on interruption `.ended` if we were
    actually playing when it began (`wasPlayingBeforeInterruption`) — otherwise the
    charging chime (a brief interruption) resumes a paused book.
- **Downloads store absolute file URIs**; the iOS document-container path can change
  between installs (notably dev rebuilds), so `src/downloads/store.ts` (downloads is
  a top-level dir, a sibling of `src/playback`) `relocateEntry`
  re-resolves each file's URI against the live root on hydrate (via `engine.localUri`)
  — without it a stale path fails the existence check and the book is dropped *and
  deleted*. Keep the on-disk filename scheme (`fileName(i, relPath)` + `cover.jpg`) and
  `engine.localUri` in agreement.
- **Stream the file, not the book.** A track URL must be a real audio file
  (a chapter's `file_path` or a `BookFile.rel_path`) — **never** a folder/book path.
  `book-queue.ts` builds tracks from `files`, else derives distinct files from the
  chapters' `file_path`, else a single-file book path.
- **Whole-book timeline.** The engine works per-track; `store.ts` maps
  `(trackIndex, position)` ↔ whole-book position via cumulative `offsets`, and
  overlays chapters by `book_offset`. The full player's seek bar is **chapter-relative**.
- **Start playback only after chapters/files have loaded** (the player gates on
  `useChapters` settling) — starting early made multi-file books stream the folder
  path (MediaToolbox `-12864`) and lose chapter info.
- Progress: `progress-sync.ts` saves last-write-wins (`version: 0` + `updated_at`,
  server reconciles) with an offline replay queue; `store.ts` saves every 15s while
  playing and on pause/seek/rate/stop/ended.

**Tests** — new logic ships with a unit test. Pure, framework-free modules get
direct tests: `src/api/client.ts`, `src/lib/*`, `src/playback/book-queue.ts` +
`progress-sync.ts`, `src/stores/*` (see the co-located `*.test.ts`). Keep logic out
of `src/app/**` screens so it stays unit-testable. Harness: **jest-expo (jest 29)
+ @testing-library/react-native 14** — matchers are built in (no `jest-native`);
`jest.setup.ts` provides in-memory mocks for `expo-secure-store` + AsyncStorage,
and tests mock `fetch` / `@/api/reachability` as needed. Flip `Platform.OS` at
runtime to cover web-vs-native branches.

**Styling**: use `className` on core RN components (NativeWind). Never import an
icon lib directly — use `<Icon name=... />` (`src/components/ui/icon.tsx`). Text via
`<Text variant=... />`. Tokens: primary `#db2777`; grays `750/840/860`; Roboto
weights as `font-roboto-{light,medium,semibold,bold}` (plain `font-sans` = regular).
Raw color values for native props in `src/theme/tokens.ts`.

**Routing**: `src/app/(app)/*` is the authenticated shell (guarded in its
`_layout.tsx`); `src/app/connect/*` is onboarding; `src/app/player.tsx` is a modal.
Library browse uses `library/[libraryId]/index.tsx` (root) + `library/[libraryId]/[...path].tsx`
(sub-path), both re-exporting `src/components/library/browse-screen.tsx`; book detail
is `book/[libraryId]/[...path].tsx`. Path helpers in `src/lib/paths.ts`.

## Layout
```
src/app/            Expo Router routes ((app) shell, connect/, player modal)
src/api/            client.ts, types.ts, hooks.ts (React Query), provider.tsx
src/playback/       PlaybackService + web/native engines, store, book-queue, progress-sync
src/downloads/      offline downloads: native/web engines + store (sibling of playback)
src/components/      ui/ (primitives + Icon), layout/ (shell/header/nav), player/, library/
src/stores/         Zustand: session, search, settings
src/i18n/           i18next setup, language provider, locale JSONs (locales/)
src/theme/          tokens + ThemeProvider
src/lib/            storage, secure-store, device, paths, format, register-sw
```

@AGENTS.md
