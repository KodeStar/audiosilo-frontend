# AudioSilo Frontend — project guide

The audiobook **player** frontend for **audiosilo-server** (a self-hosted Go
audiobook server at `~/dev/audiosilo-server`). One Expo / React Native codebase
shipping to **web PWA + iOS + Android**. Design is ported from the old Nuxt
client at `~/dev/audiosilo` (pink-accented, Roboto, dark-mode-first).

Full roadmap and milestone status: [docs/PLAN.md](docs/PLAN.md). M1 is complete;
M2–M5 pending.

## Stack
- **Expo SDK 56**, **React Native 0.85** (new architecture), **React 19**, **Expo Router** (file-based, in `src/app`).
- **NativeWind v4** (Tailwind v3.4 engine) for styling. Tokens in `tailwind.config.js`, directives in `src/global.css`.
- **TanStack Query** (server state) + **Zustand** (session + player state).
- **react-native-track-player 5.0.0-alpha** on native / **HTML5 Audio + Media Session** on web.
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
- **Native runs need a dev build, not Expo Go** (track-player, svg, secure-store
  are native modules): `npx expo prebuild` then `npx expo run:ios` / `run:android`.
- **Web dev needs CORS**: set `cors_origins` in the server config to the web origin
  (e.g. `http://localhost:8081`), or serve same-origin. Self-signed TLS may need
  trusting / `tls.mode: autocert`.
- Run tool commands from the **repo root** (a stray `cd` into `node_modules`
  persists between Bash calls and breaks Expo's config resolution).

## Commands
```sh
npm run web                 # expo start --web (testable without a dev build)
npm run ios / npm run android
npx tsc --noEmit            # typecheck (must stay clean)
npx expo export -p web      # bundle smoke test (run after meaningful changes)
```

## Architecture & conventions

**Path is identity.** All content is addressed by `(library_id, rel_path)`, never
a DB id. Every content call passes `?path=<rel_path>`; persist client state keyed
by `(library_id, path)`. See `src/api/client.ts` + `src/api/types.ts`.

**API envelopes** (from the Go handlers): auth returns `{ token, user }`; `/me`
returns the user directly; lists are wrapped (`{ libraries }`, `{ books, next_cursor }`,
`{ progress }`, `{ bookmarks }`, `{ notes }`); errors are `{ error }`. Pairing deep
link is `audiosilo://pair?url=<base>&token=<pairing_token>`.

**Media auth differs by platform** (`src/api/client.ts` `mediaTokenQuery`): web
embeds `?token=` in cover/stream URLs (`<img>`/`<audio>` can't set headers);
native passes `Authorization` headers. **This depends on a server change** in
`audiosilo-server` `internal/api/middleware.go` — `bearerToken` falls back to a
`token` query param for media GETs.

**Playback (`src/playback/`)** — the fiddly part:
- `PlaybackService` interface (`types.ts`). Metro resolves the engine per platform:
  `service.web.ts` (HTML5 + Media Session) / `service.native.ts` (track-player).
  `service.ts` is a throwing fallback for tsc only. `register.native.ts` registers
  the track-player background service and is imported (side-effect) by the root layout.
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
src/components/      ui/ (primitives + Icon), layout/ (shell/header/nav), player/, library/
src/stores/         session (Zustand)
src/theme/          tokens + ThemeProvider
src/lib/            storage, secure-store, device, paths, format
```

@AGENTS.md
