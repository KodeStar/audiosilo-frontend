# AudioSilo Frontend - project guide

The audiobook **player** frontend for **audiosilo-server** (a self-hosted Go
audiobook server at `~/dev/audiosilo/audiosilo-server`). One Expo / React Native codebase
shipping to **web PWA + iOS + Android**. Design is ported from the old Nuxt
client at `~/dev/audiosilo-old` (pink-accented, Roboto, dark-mode-first).

Full roadmap and milestone status: [docs/PLAN.md](docs/PLAN.md). M1–M2 complete;
**M3 (offline downloads)** shipped (`src/downloads/` - `engine.native.ts`/
`engine.web.ts`/`store.ts`, a `(app)/downloads` route, and the
`download-control`/`download-badge` components); **M4 (PWA / service worker)**
shipped (`public/sw.js`, `public/manifest.json`, `src/lib/register-sw{,.web}.ts`).
Several features have landed since the original plan: **demo mode**, **favourites**,
**self-service recovery**, and **i18n** (`src/i18n/`). M5 (release/store) is the main
remaining track.

## Model routing (every session follows this)

Sessions in this repo run a fixed division of labour between models:

- **Fable (the main session) is the orchestrator only.** It owns task
  decomposition, orchestration, design taste/direction, and final QA of every
  delegated piece. It **never writes feature code directly** - it reviews diffs,
  runs the gate, and sends work back when it falls short. Runs at **high**
  effort (do not escalate to xhigh/max).
- **Opus subagents do the implementation.** Spin up one subagent per task
  (`model: "opus"`); run them in parallel when tasks are independent, in
  sequence when one depends on another's output. Each subagent gets a
  self-contained brief (files, constraints, acceptance criteria) and must leave
  the gate green for the code it touched.
- **Token-hungry chores go to cheaper models** (Sonnet/Haiku): bulk codebase
  analysis/inventories, computer use, screenshot sweeps, log triage. They
  report findings back; they don't make design decisions.

## Stack
- **Expo SDK 56**, **React Native 0.85** (new architecture), **React 19**, **Expo Router** (file-based, in `src/app`).
- **NativeWind v4** (Tailwind v3.4 engine) for styling. Tokens in `tailwind.config.js`, directives in `src/global.css`.
- **TanStack Query** (server state) + **Zustand** (session + player state).
- **Custom native playback module** (`modules/audiosilo-player`, a local Expo
  module): **AVQueuePlayer** on iOS, **Media3/ExoPlayer** on Android. **HTML5 Audio +
  Media Session** on web. (This replaced react-native-track-player - that dep is gone;
  ignore any older doc that still names it.)
- **Icons**: FontAwesome Pro 7 glyphs **vendored as raw SVG** in
  `src/components/ui/icon-data.ts` and drawn with `react-native-svg` - the app has
  **no `@fortawesome/*` dependency** (so no token to build). To add/change an icon,
  edit `scripts/glyphs/manifest.mjs` and regenerate (see `scripts/glyphs/README.md`).
- **expo-secure-store** for the session token; **AsyncStorage** for everything else.

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

## Architecture & conventions

**Path is identity, scoped by connection.** All content is addressed by
`(library_id, rel_path)`, never a DB id, and every content call passes
`?path=<rel_path>`. But the app is **multi-connection** (signed in to several
servers at once, and two servers can each have a "library 1"), so **durable/cache
client state is additionally scoped by connection id**: React Query keys (`qk.*`),
the downloads registry + on-disk/Cache-API files, the progress mirror + offline
replay queue, and browse scroll memory all key on `(connectionId, library_id,
path)`, not just `(library_id, path)`. Without the connection id two servers'
libraries bleed together and the offline queue could replay one server's positions
onto another. The seam is `src/api/connection-clients.ts` - framework-free modules
(progress-sync, the downloads store) resolve a connection id to its `ApiClient`
(`resolveClient`) and gate on the session having hydrated (`sessionReady`) before
reading storage, without importing React; removing/signing out of a connection
**purges** its scoped state through the `onConnectionRemoved` registry in
`src/stores/session.ts`. Client state left incompatible by the id scheme moving to the
server-minted `server_id` (a `STORAGE_VERSION` bump) is cleared once, before any store
hydrates, by `resetStaleStorage()` (the user re-pairs). See `src/api/client.ts` +
`src/api/types.ts`.

**API envelopes** (from the Go handlers): auth returns `{ token, user }`; `/me`
returns the user directly; lists are wrapped (`{ libraries }`, `{ books, next_cursor }`,
`{ progress }`, `{ bookmarks }`, `{ notes }`); errors are `{ error }`. Pairing deep
link is `audiosilo://connect?server=<base>&token=<pairing_token>`.

**Self-service recovery.** `User` carries `has_password`/`has_recovery`. A signed-in
user can set a password (`client.setPassword`) and/or mint a durable **recovery code**
(`client.generateRecoveryCode`) from Settings so they can get back in after signing out
without an admin. A recovery code is just an auth code the user owns - it redeems through
the same `redeemCode → exchange` path as an invite, so the connect screen's code field
accepts either. Sign-out is guarded (`src/lib/recovery.ts` `needsRecoveryWarning`):
a user with neither credential is warned and offered a recovery code before their only
way in is revoked (`src/components/account/sign-out-confirm.tsx`).

**Personal API keys.** The per-server account screen (`src/app/(app)/account.tsx`)
renders an API-keys section (`src/components/account/api-keys-section.tsx` +
`use-api-keys-manager.ts`, one-time secret via `api-key-created-modal.tsx`) for
user-minted, non-expiring bearer tokens (dashboards, cron). It is **capability-gated**
(server `api_keys`) and **demo-hidden**. State is connection-scoped: hooks
(`useApiKeys`/`useCreateApiKey`/`useRevokeApiKey`) key on `qk.apiKeys(cid)`;
`client.{createApiKey,listApiKeys,revokeApiKey}` hit `/auth/tokens`. The secret is
returned once by `createApiKey` and shown in the copy-once modal (`ApiKeyCreated`);
the list is metadata-only (`ApiKey`, with `last_seen`). Strings under
`settings.apiKeys.*`.

**Media auth rides in the URL on every platform** (`src/api/client.ts`
`mediaTokenQuery`): cover/stream URLs embed `?token=` everywhere (`<img>`/
`<audio>` can't set headers on web, and native image/player components don't
reliably forward custom headers); native *additionally* sends the
`Authorization` header belt-and-braces. **This depends on the server's**
`internal/api/middleware.go` - `bearerToken` accepts a `token` query param for
media GETs only.

**Playback (`src/playback/`)** - the fiddly part:
- `PlaybackService` interface (`types.ts`). Metro resolves the engine per platform:
  `service.web.ts` (HTML5 + Media Session) / `service.native.ts`, which is a thin
  bridge to the **custom native module** `modules/audiosilo-player` (AVQueuePlayer on
  iOS, Media3/ExoPlayer on Android - that module owns the audio session, background
  audio, lock-screen/remote commands, gapless multi-file playback, and pitch-corrected
  speed). `service.ts` is a throwing fallback for tsc only. (There is **no**
  `register.native.ts` and no react-native-track-player - both are gone; the native
  module registers its own background service.)
- **The native module is where the OS-integration bugs live**, and it can only be
  validated by a device rebuild. Known iOS gotchas now handled in
  `AudiosiloPlayerModule.swift` (read its comments before touching it):
  - **Seek before ready.** Seeking a freshly-created `AVPlayerItem` before it reaches
    `.readyToPlay` is silently dropped (esp. streaming) - this made resume start from
    0. The resume/skip start position is **deferred** until `.readyToPlay`
    (`pendingSeek`/`applyPendingSeek`), with play gated (`wantsPlay`) so audio never
    briefly starts at 0. Android doesn't have this - Media3's `setMediaItems(items,
    startIndex, startPositionMs)` honors the start natively.
  - **Single earbud press / "pause needs two presses".** `MPNowPlayingInfoCenter.
    playbackState` is entitlement-gated and silently ignored for third-party apps, so
    iOS infers our play state itself and can get stuck (sending Play while we're already
    playing, so the press no-ops). Fix: route the play, pause AND toggle remote commands
    all through one real-transport-state `togglePlayback()` (reads
    `player.timeControlStatus`), so a single press always flips playback. (There is no
    `syncPlaybackState` - that was an earlier, abandoned approach.)
  - **Interruption auto-resume.** Only resume on interruption `.ended` if we were
    actually playing when it began (`wasPlayingBeforeInterruption`) - otherwise the
    charging chime (a brief interruption) resumes a paused book.
- **Android lock screen = chapter controls (Audible parity)** (`AudiosiloPlayerService.kt`
  + `AudiosiloPlayerModule.kt`). Each **chapter is a clipped `MediaItem`**
  (`MediaItem.ClippingConfiguration`, built from the `chapters` arg to `load`), so the
  system scrubber is **chapter-relative** and `COMMAND_SEEK_TO_*_MEDIA_ITEM` give
  **prev/next chapter**; **30s skip buttons** use Media3's **predefined** `CommandButton`
  icon constants (`ICON_SKIP_BACK_30`/`ICON_SKIP_FORWARD_30`, since Media3 **1.5.0** - no
  app-shipped drawable, not icon-less, so the old "Android 16 drops icon-less actions"
  problem is gone), wired as **custom session commands** (`setSessionCommand` +
  `MediaSession.Callback.onCustomCommand` → `player.seekBack()/seekForward()`), **NOT**
  `COMMAND_SEEK_BACK/FORWARD` - those map to the legacy `ACTION_REWIND`/`FAST_FORWARD` that
  the modern Android media UI silently ignores (`dumpsys media_session` showed
  `custom actions=[]` and no buttons). **Register them with `setCustomLayout`, NOT
  `setMediaButtonPreferences`**: the slot-based preferences API caps the 1.5.1 notification
  at 3 actions (drops the secondary slots - `dumpsys notification` showed `actions=3`),
  whereas `setCustomLayout` makes the provider emit standard `[prev, play, next]` (auto, when
  the seek-to-prev/next commands are available) **+** the custom skip buttons = all 5
  actions, alongside the draggable chapter scrubber → the full lock-screen row
  `[prev-ch] [scrubber] [next-ch] [back-30] [fwd-30]` (`dumpsys`: `actions=5`,
  device-verified on a Pixel). The **app logo** is
  the notification small icon (`DefaultMediaNotificationProvider.setSmallIcon` +
  `android/.../res/drawable/ic_notification.xml`). `AudiobookPlayer` (a `ForwardingPlayer`)
  still applies auto-rewind on every `play()` and hides prev/next **only when there's a
  single item** (a chapterless single-file book, so "previous" can't restart it). **The JS
  store + iOS stay file-based**: the Android module translates between its chapter clips and
  the file-relative `(trackIndex, position)` the bridge reports (`ChapterMap`
  `fileToItem`/`itemToFile`); `buildChapterClips` (`book-queue.ts`) returns `[]` for 0/1
  chapters → one item per file (today's behavior). A `SimpleCache`/`CacheDataSource` keeps
  clipped single-file **streaming** gapless (clips re-open the same URL) - gapless was
  device-verified on a Pixel (no audible gap at chapter boundaries); the safety fallback if
  a future device regresses is to make `buildChapterClips` return `[]` for single-file
  books. iOS keeps `preferredIntervals` + a whole-file Now Playing scrubber (chapter parity
  on iOS is a follow-up).
- **Downloads store absolute file URIs**; the iOS document-container path can change
  between installs (notably dev rebuilds), so `src/downloads/store.ts` (downloads is
  a top-level dir, a sibling of `src/playback`) `relocateEntry`
  re-resolves each file's URI against the live root on hydrate (via `engine.localUri`)
  - without it a stale path fails the existence check and the book is dropped *and
  deleted*. Keep the on-disk filename scheme (`fileName(i, relPath)` + `cover.jpg`) and
  `engine.localUri` in agreement. **Files are stored per-connection**: native
  `downloads/<connectionId>/<libraryId>/<slug>/`, web Cache API
  `/_offline/<connectionId>/<libraryId>/<slug>/`; the registry keys on
  `downloadKey(connectionId, libraryId, path)`. Pre-scoping downloads (from before the
  `server_id` id scheme) can't be re-keyed, so the one-time `resetStaleStorage()` bump
  clears the registry and `engine.clearAll()` wipes the whole downloads root once (run
  from `_layout.tsx` before the stores hydrate). `onConnectionRemoved` deletes a removed
  server's downloaded files.
- **Stream the file, not the book.** A track URL must be a real audio file
  (a chapter's `file_path` or a `BookFile.rel_path`) - **never** a folder/book path.
  `book-queue.ts` builds tracks from `files`, else derives distinct files from the
  chapters' `file_path`, else a single-file book path.
- **Whole-book timeline.** The engine works per-track; `store.ts` maps
  `(trackIndex, position)` ↔ whole-book position via cumulative `offsets`, and
  overlays chapters by `book_offset`. The full player's seek bar is **chapter-relative**.
- **Start playback only after chapters/files have loaded** (the player gates on
  `useChapters` settling) - starting early made multi-file books stream the folder
  path (MediaToolbox `-12864`) and lose chapter info.
- Progress: `progress-sync.ts` saves last-write-wins (`version: 0` + `updated_at`,
  server reconciles) with an offline replay queue; `store.ts` saves every 15s while
  playing and on pause/seek/rate/stop/ended.
- **Never restart an in-progress book from 0.** `loadInitialProgress` returns a
  discriminated `ResumeLookup` (`progress`/`empty`/`failed`) reconciling the server, a
  **durable local mirror** (`writeMirror`, never pruned on sync - survives a flaky resume
  fetch), and the offline queue by `updated_at`. `playBook` resumes from `progress`; on
  `failed` for a **streaming** book it sets an `error` (retry re-runs the lookup) instead
  of silently starting at 0; `empty`/downloaded-`failed` start at 0 (genuinely new). A
  **save guard** (`resumeFloor` in `store.ts`) refuses to persist a position far below
  where we resumed unless a deliberate seek lowered the floor - so a slipped restart can't
  overwrite real progress (the server is last-write-wins). This fixed the beta "book
  restarted from the beginning" report.
- **Stall → error watchdog lives in shared JS** (`store.ts`), not per-engine, and is
  **armed by the play/retry action, not by interpreting engine events** - this is the key
  to robustness, because the native bridge's resume/retry event stream is noisy and
  out-of-order (see below). `beginPlaybackAttempt()` (called from `playBook`/`retry`/
  `toggle`-play) sets `wantsPlayback` + `startingPlayback` and starts a `STALL_GRACE_MS`
  (3s) timer; if the engine hasn't reached `playing` when it fires, the store synthesizes
  an `error` so the player can offer a retry. Only reaching `playing` (or a user
  pause/stop) cancels it; a mid-playback stall (`playing`→`loading`) re-arms it. The fire
  test is simply "not playing", so no transient state can prevent it.
- **Why not interpret engine events:** `service.native.ts` keeps ONE merged snapshot and
  re-emits it on every event, and iOS delivers `timeControlStatus`/status KVO
  asynchronously - so on a resume/retry the store sees a jumble of `ready`, frozen
  `onProgress` ticks carrying `loading`, and a spurious `paused` (an async `.paused` from
  the queue rebuild that escapes the native `rebuilding` guard). Trying to drive the
  spinner/watchdog by reacting to those individually failed three different ways (error
  flashed then reverted; stuck at a dead `ready` play button; spinner that never armed the
  watchdog because the spurious `paused` cleared intent). So instead: while
  `startingPlayback`, `subscribe` **collapses every non-`playing`/non-`error` state to
  `loading`** (spinner), and the action-armed watchdog guarantees resolution. A genuine
  user/lock-screen pause arrives AFTER `playing` (startingPlayback already false), so it
  still reads as `paused`.
- The synthesized `error` is also **held** against the engine's continued re-reports:
  `subscribe` drops EVERY incoming state except `playing` while `prev` is `error` and no
  retry is in flight. This is suppress-all-but-`playing`, not an allow-list - enumerating
  the noisy states bit us repeatedly (iOS frozen `onProgress` ticks carrying `loading`;
  Android `onPlayerError` → `STATE_IDLE` → `idle` plus its own ticks → a flash→spinner
  loop). It's released by a retry (`wantsPlayback` true) or a genuine `playing`. The
  engines only report raw transport state - iOS reports `loading` on a `.waiting`/`.failed`/stall
  (it does **not** decide `error` itself); web/Android may emit a real `error` directly
  (the watchdog is then a backstop for a buffer that never resolves). Recovery is
  `retry()` (reloads the track - a dead source can't resume via `play()` alone). Keep this
  one place; don't re-add a native timer.

**Tests** - new logic ships with a unit test. Pure, framework-free modules get
direct tests: `src/api/client.ts`, `src/lib/*`, `src/playback/book-queue.ts` +
`progress-sync.ts`, `src/stores/*` (see the co-located `*.test.ts`). Keep logic out
of `src/app/**` screens so it stays unit-testable. Harness: **jest-expo (jest 29)
+ @testing-library/react-native 14** - matchers are built in (no `jest-native`);
`jest.setup.ts` provides in-memory mocks for `expo-secure-store` + AsyncStorage,
and tests mock `fetch` / `@/api/reachability` as needed. Flip `Platform.OS` at
runtime to cover web-vs-native branches.

**Styling**: use `className` on core RN components (NativeWind). Never import an
icon lib directly - use `<Icon name=... />` (`src/components/ui/icon.tsx`). Text via
`<Text variant=... />`. Tokens: primary `#db2777`; grays `750/840/860`; Roboto
weights as `font-roboto-{light,medium,semibold,bold}` (plain `font-sans` = regular).
Raw color values for native props in `src/theme/tokens.ts`.

**Routing**: `src/app/(app)/*` is the authenticated shell (guarded in its
`_layout.tsx`); `src/app/connect/*` is onboarding; `src/app/player.tsx` is a modal.
Content routes are **flat** - `library/[libraryId].tsx` (re-exports
`src/components/library/browse-screen.tsx`), `book/[libraryId].tsx`, `account.tsx` -
and carry **both the connection and the library-relative path as query params**
(`/book/[libraryId]?connection=<cid>&path=<rel>`). The connection is NOT a
`/s/[connectionId]/` route segment: `router.push` (React Navigation's `linkTo`) can't
resolve a tap into a route nested under a dynamic layout segment - it lands on the
group's first child - whereas a flat route + query param pushes correctly (a direct URL
load worked either way via `getStateFromPath`, which is why the bug only bit in-app
navigation). The `(app)/_layout.tsx` reads `?connection=` and republishes it as the
`ConnectionScope` the content hooks read via `useScopedCid()`. Path helpers +
the full rationale are in `src/lib/paths.ts`.

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
