# AudioSilo Frontend — Implementation Plan

> Status (2026-06-18): **Milestone 1 complete** (scaffold, design system, API
> client, connect/auth, browse + book detail, hybrid player, progress sync).
> M2–M5 are pending. This is the original approved plan, kept for reference; see
> [CLAUDE.md](../CLAUDE.md) for current architecture, conventions, and gotchas.

## Context

`audiosilo-server` (Go) is a self-hosted audiobook server exposing a JSON API at `/api/v1`. Its README states the audiobook **player** frontend is "planned separately; only the admin/connect UI ships in this binary." This repo (`audiosilo-frontend`) is where that player frontend lives.

The **old client** at `~/dev/audiosilo` — a Nuxt 2 / Vue / Tailwind v2 PWA wrapped with Capacitor, built for a *different* backend (Audioserve) — is the reference for **look, feel, and functionality**, rebuilt as a **single Expo / React Native codebase** shipping to three targets:

- **Web PWA** — the build we bundle with / serve alongside the Go server.
- **iOS** and **Android** — native apps via EAS Build.

**Outcome:** one responsive, offline-capable audiobook player matching the old client's pink-accented, dark-mode-first design, talking to the path-addressed API, from one codebase.

### Decisions locked (from user)
- **Playback:** Hybrid — `react-native-track-player` on native (5.0.0-alpha for the new architecture / RN 0.85), HTML5 + Media Session on web, behind one shared `PlaybackService` interface. Requires a dev build, not Expo Go.
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
| HTML5 `<audio>` + Cache API | Hybrid: track-player (native) / HTML5 (web) |
| Google Fonts Roboto | `@expo-google-fonts/roboto` |
| Shake-to-cancel (DeviceMotion) | `expo-sensors` Accelerometer (M2) |
| Offline download (Cache API) | `expo-file-system` (native) / SW (web) (M3) |

## Milestones

**M1 — core (done):** scaffold; FA Pro icons; NativeWind theme + responsive shell; typed API client + session store + React Query; connect/auth (server URL, auth-code, password, logout, guard); library browse + book detail; hybrid playback (PlaybackService, web + native engines, MiniPlayer + full Player); progress sync (resume, last-write-wins saves, offline queue, Home continue-listening).

**M2 — listening features:** bookmarks (add at timestamp, list, delete), notes (markdown via `react-native-markdown-display`), history sessions, sleep timer (presets + end-of-chapter, on-cover countdown, shake-to-cancel), full settings (skip ± seconds, default speed, transcode placeholder, version). Finish **search results** rendering (hook exists; results not yet shown).

**M3 — offline:** download books/chapters via `expo-file-system` (native) / Cache API + SW (web); cached indicators, download progress, delete; offline playback.

**M4 — PWA + server bundling:** Expo static web export → Workbox SW + web manifest (installable, offline shell). Coordinate serving the static export from the Go server (`embed.FS` at `/web` — server-side change). Indexed-book list (`/books` keyset) + search polish; admin screens gated by `role==="admin"`.

**M5 — release:** EAS Build profiles, app icons/splash per platform (port the real logo SVG), store metadata; deep-link/universal-link verification; capability-driven feature flags (upload/transcode/websocket) for server Phases B/C.

## Verification

- Per change: `npx tsc --noEmit` clean; `npx expo export -p web` succeeds.
- Native: dev build on simulator/device; connect → browse → play; background + lock-screen controls; progress resumes after relaunch.
- Web: `expo start --web`; Media Session controls + Range seeking.
- Cross-device sync: advance on one client, resume on another (last-write-wins).
