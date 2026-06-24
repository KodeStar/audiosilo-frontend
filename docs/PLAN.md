# AudioSilo Frontend — Implementation Plan

> Status (2026-06-18): **Milestones 1–2 complete.** M1 = scaffold, design system,
> API client, connect/auth, browse + book detail, hybrid player, progress sync.
> M2 = settings (skip/speed), search results, bookmarks, markdown notes, sleep
> timer, and listening history (which added GET/POST history routes to
> audiosilo-server). M3–M5 pending. This is the original approved plan, kept for
> reference; see [CLAUDE.md](../CLAUDE.md) for current architecture and gotchas.

## Context

`audiosilo-server` (Go) is a self-hosted audiobook server exposing a JSON API at `/api/v1`. This repo (`audiosilo-frontend`) is where the audiobook **player** frontend lives. _(Historical: the server README once said the player was "planned separately; only the admin/connect UI ships in this binary." That is no longer the design — the player's web build is now served **by the server at `/web`** from `web_dir`; see [CROSS-REPO.md](../../CROSS-REPO.md) §9.)_

The **old client** at `~/dev/audiosilo-old` — a Nuxt 2 / Vue / Tailwind v2 PWA wrapped with Capacitor, built for a *different* backend (Audioserve) — is the reference for **look, feel, and functionality**, rebuilt as a **single Expo / React Native codebase** shipping to three targets:

- **Web PWA** — the build we bundle with / serve alongside the Go server.
- **iOS** and **Android** — native apps via EAS Build.

**Outcome:** one responsive, offline-capable audiobook player matching the old client's pink-accented, dark-mode-first design, talking to the path-addressed API, from one codebase.

### Decisions locked (from user)
- **Playback:** Hybrid behind one shared `PlaybackService` interface, HTML5 + Media Session on web. _(Originally planned on `react-native-track-player` 5.0.0-alpha; that proved unreliable on the new architecture, so native playback was rebuilt as a **custom local Expo module**, `modules/audiosilo-player` — AVQueuePlayer on iOS, Media3/ExoPlayer on Android. track-player is no longer a dependency.)_ Requires a dev build, not Expo Go.
- **Scope:** Phased. Milestone 1 = scaffold + design system + connect/auth + browse + working player + progress sync. Features layered after.
- **Icons:** FontAwesome Pro via npm auth token from the start.
- **Web media auth:** server accepts a `?token=` query param for media GETs (covers/stream) since browsers can't set an Authorization header on `<img>`/`<audio>`.

## Modernization mapping (old → new)

| Old client (2021) | New client (2026) |
|---|---|
| Nuxt 2 / Vue, file-based `/pages` | Expo + Expo Router (file-based routes) |
| `@nuxtjs/tailwindcss` (Tailwind v2) | NativeWind v4 (Tailwind v3.4 engine) |
| `@nuxtjs/color-mode` | NativeWind dark mode + persisted theme toggle |
| Vuex | Zustand (UI/player) + TanStack Query (server state) |
| `@nuxtjs/localforage` | AsyncStorage + expo-secure-store (token) |
| `@nuxtjs/pwa` | Expo static web export + service worker + manifest (M4) |
| Capacitor | Expo prebuild + EAS Build |
| FA Pro Kit (CDN) | `@fortawesome/react-native-fontawesome` + pro `*-svg-icons` |
| HTML5 `<audio>` + Cache API | Hybrid: custom `audiosilo-player` native module (AVQueuePlayer / Media3) / HTML5 (web) |
| Google Fonts Roboto | `@expo-google-fonts/roboto` |
| Shake-to-cancel (DeviceMotion) | `expo-sensors` Accelerometer (M2) |
| Offline download (Cache API) | `expo-file-system` (native) / SW (web) (M3) |

## Milestones

**M1 — core (done):** scaffold; FA Pro icons; NativeWind theme + responsive shell; typed API client + session store + React Query; connect/auth (server URL, auth-code, password, logout, guard); library browse + book detail; hybrid playback (PlaybackService, web + native engines, MiniPlayer + full Player); progress sync (resume, last-write-wins saves, offline queue, Home continue-listening).

**M2 — listening features (done):** settings (skip ± seconds, default speed, version), search results, bookmarks (add from player, list/jump/delete), markdown notes (via `react-native-marked`), sleep timer (duration + end-of-chapter, on-cover countdown, shake-to-cancel via `expo-sensors`), and listening history. History required new `audiosilo-server` routes (`GET /me/history`, `GET`/`POST /libraries/{id}/history`) backed by the existing `catalog` history table.

**M3 — offline:** download books/chapters via `expo-file-system` (native) / Cache API + SW (web); cached indicators, download progress, delete; offline playback.

**M4 — PWA + server bundling:** Expo static web export → Workbox SW + web manifest (installable, offline shell). Coordinate serving the static export from the Go server. Indexed-book list (`/books` keyset) + search polish; admin screens gated by `role==="admin"`.

> **Update (shipped design):** the `embed.FS`-at-`/web` approach was **dropped** in
> favour of **runtime serving from `web_dir`** — the server serves the player at `/web`
> from `AUDIOSILO_WEB_DIR` (not vendored, not embedded in the binary), and the Docker
> image bakes a *pinned* build into `/app/web`. See [CROSS-REPO.md](../../CROSS-REPO.md)
> §9 / §11.

**M5 — release:** EAS Build profiles, app icons/splash per platform (port the real logo SVG), store metadata; deep-link/universal-link verification; capability-driven feature flags (upload/transcode/websocket) for server Phases B/C.

## Server-side notes & follow-ups

The clients depend on two small `audiosilo-server` changes:
- `internal/api/middleware.go` — `bearerToken` accepts a `?token=` query param for
  media GETs. Browsers can't set an Authorization header on `<img>`/`<audio>`, so web
  needs it; native also uses it for a single uniform media-auth path that doesn't
  depend on whether expo-image / the native player module forward custom headers (the
  native module *does* pass headers too — this is belt-and-braces). The token rides in
  the media URL on every platform.
- `internal/media/media.go` — `ServeFile` sets a real audio `Content-Type` by
  sniffing the file's magic bytes (`ftyp`→`audio/mp4`, ID3/MPEG sync→`audio/mpeg`,
  ADTS→`audio/aac`, `fLaC`, `OggS`, `RIFF/WAVE`), falling back to the extension.
  Without this, `.m4b`/`.aax` served as `application/octet-stream` + `nosniff` are
  rejected by iOS AVPlayer (`-12847`).

**Future — exact codec/MIME at index time:** the scanner already runs ffprobe for
durations/chapters; have it also record each file's container/codec/MIME in the
catalog and serve that stored value. Gives precise types (e.g. Opus vs Vorbis,
AAC vs ALAC) with zero per-request work — the byte-sniff above is the pragmatic
interim. (`ffprobe`-ing the live stream URL is also the go-to "check, don't
assume" debugging tool.)

## Verification

- Per change: `npx tsc --noEmit` clean; `npx expo export -p web` succeeds.
- Native: dev build on simulator/device; connect → browse → play; background + lock-screen controls; progress resumes after relaunch.
- Web: `expo start --web`; Media Session controls + Range seeking.
- Cross-device sync: advance on one client, resume on another (last-write-wins).
