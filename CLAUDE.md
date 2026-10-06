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
`download-control`/`download-badge` components); **M4 (PWA / service worker)**
shipped (`public/sw.js`, `public/manifest.json`, `src/lib/register-sw{,.web}.ts`).
Several features have landed since the original plan: **demo mode**, **favourites**,
**self-service password**, and **i18n** (`src/i18n/`). M5 (release/store) is the main
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
`src/stores/session.ts`. Stale persisted state is reconciled once, before any store
hydrates, by `resetStaleStorage()` (run inside the memoised launch migration `migrateStorage()`,
`src/lib/storage-migration.ts`, which the root layout and ThemeProvider both await) along **two independent version axes** so cache churn
can never log anyone out (`{ authReset, cacheReset }`):
- **`AUTH_STORAGE_VERSION`** gates the auth wipe (connections + their secure-store session
  tokens). Session tokens never expire server-side, so wiping them is the ONLY thing that
  logs a user out and forces a re-pair. Bump it **ONLY** when the connection *identity
  scheme itself* changes (like v2: ids became the server-minted `server_id`) - a
  deliberate, rare, breaking act that logs **everyone** out. **Never bump it for a cache
  reason.**
- **`CACHE_STORAGE_VERSION`** gates the disposable per-server cache (downloads + the
  progress mirror/queue + the on-disk downloads root). Bump **this** for any scoped-state /
  cache schema change: it wipes that cache (it re-downloads / re-syncs from the server)
  while keeping every login intact. A pre-existing install that predates this split adopts
  the cache version silently, without wiping its downloads.

`_layout.tsx` wipes the downloads root via `engine.clearAll()` when **either** axis reset.
`migrateStorage()` first writes the theme default (see Theme below), so the existing-install signal is read
before the reset can rewrite the session keys - no effect-order contract.
See `src/api/client.ts` + `src/api/types.ts`.

**API envelopes** (from the Go handlers): auth returns `{ token, user }`; `/me`
returns the user directly; lists are wrapped (`{ libraries }`, `{ books, next_cursor }`,
`{ progress }`, `{ bookmarks }`, `{ notes }`); errors are `{ error }`. Pairing deep
link is `audiosilo://connect?server=<base>&token=<pairing_token>`.

**Client identification.** `ApiClient.request()` sends
`X-AudioSilo-Client: AudioSilo/<APP_VERSION or dev> (<Platform.OS>)` on every API call
so the server can record which app owns each session token (`src/lib/client-id.ts`).
On web it is sent **only when the API base is same-origin with the page**: a custom
header makes a cross-origin request non-simple (CORS preflight), and servers released
before the header don't allow it. The embedded `/web` player is same-origin and always
identifies; native has no CORS. `authHeaders()` (media layers) does not carry it.

**Self-service password.** A signed-in user can set/change a password
(`client.setPassword`) from the per-server account screen so they can get back in on any
device after signing out without an admin. Sign-out is guarded
(`src/lib/account.ts` `needsPasswordWarning`): a non-admin, non-demo user with **neither a
password nor a recovery code** (`has_password === false && has_recovery === false`) is
warned before their only credential (the session token) is revoked - a legacy user who
still holds a working recovery code is exempt (it re-pairs them via the connect screen's
code field, so the "you'll need a new invite" warning would be false for them). The
warning's remedy is **"Set a password"** - it dismisses the
sheet and opens the account screen's set-password editor
(`src/components/account/sign-out-confirm.tsx`). The connect screen's code field still
redeems an admin invite code as the other way in.

The **recovery-code** feature (a durable user-owned auth code minted from Settings) was
**removed from this client's UI** - it was confusing and unused. The server keeps its
`/auth/recovery` endpoints for already-shipped older clients, and `/me` still returns a
`has_recovery` field, so `User.has_recovery` (`src/api/types.ts`) is **retained as a
tolerated legacy wire field** (marked `@deprecated`). The only reader is
`needsPasswordWarning` (above), which uses it solely to **suppress** the sign-out warning
for a legacy user who still holds a working recovery code - the feature itself has no UI.
Any legacy recovery code a user still holds keeps working because the connect
screen's code field redeems it through the same `redeemCode → exchange` path as an invite.

**Dead-token reconnect.** Session tokens never expire server-side, so an involuntary
logout is rare - but when a token IS genuinely dead (admin revoked it, or the server's
data dir was reset) the app must not fail every request silently forever. Detection lives
at ONE choke point - the `ApiClient` itself - so it covers **every** request path
(queries, the `useMutation`s in `src/api/hooks.ts`, and the framework-free progress-sync
save loop) without per-call handling or a background poller. `ApiClient.request()` invokes
an injected `onAuthError` callback whenever a request produces an `ApiError` with status
**401 only** (a 403 is "valid token, forbidden" - a scope/share denial, admin-only, or
api-key/demo restriction - NOT a dead token, so flagging it would false-positive the
reconnect prompt for a scoped user browsing outside their share). That check is reliable
because `ApiClient` only throws `ApiError` for a real HTTP response; a network/offline
failure throws `TimeoutError`/a raw fetch rejection with no status - so a 401 inherently
proves "server answered, token rejected", cleanly distinct from offline (the reachability
layer relies on the same invariant; the full rationale + the server-source citations live
on the `onAuthError` constructor doc in `client.ts`). The callback is injected wherever a per-connection client is
built - `provider.tsx`'s client map AND `connection-clients.resolveClient` - as `() =>
markNeedsReconnect(cid, 'auth')`; `client.ts` never imports the session store (no cycle).
**Onboarding** flows (connect / sign-in / demo) build bare clients with NO callback, so a
wrong-password 401 on `/auth/login` can't false-flag a reconnect. The React Query
`QueryCache` keeps only the two success-side jobs a per-request error callback can't do:
**clearing** the flag when an authenticated query succeeds (the connection id resolved from
the query key by membership against the live ids, `connectionIdFromKey`, since keys are
connection-scoped but not at a fixed index), and detecting a **server reset** by
piggybacking on the existing `useServerInfo()` fetch - a successful public `/server`
response whose `server_id` differs from the connection id flags `server-reset` (that public
success is skipped for flag-clearing, since it proves nothing about the token).

The flag is a per-connection `Connection.needsReconnect?: 'auth' | 'server-reset'` in
`src/stores/session.ts` (`markNeedsReconnect`/`clearNeedsReconnect`) - **in-memory only**
(stripped from the persisted shape, recomputed from the next failure), and marking it
never removes the connection or its token (only a successful `setSession` re-pair replaces
the token) - and `markNeedsReconnect` never downgrades a `server-reset` flag to `auth`, so
frequent authed 401s can't clobber the rarer, more informative server-reset reason. A
re-pair additionally retires any *stale same-URL connection under a different `server_id`*
(a rebuilt server mints a new id, so the old identity's dead token + scoped state are
dropped via the `onConnectionRemoved` registry rather than left as a zombie the banner
keeps re-flagging). It surfaces as a slim accent bar (`src/components/layout/reconnect-banner.tsx`,
rendered by the shell beside the offline banner - under the phone header, or under the top bar
on tablet/desktop); tapping it pre-fills `pendingServerUrl`
and routes into the EXISTING connect → sign-in screens to re-enter a code/password.
`setSession` also upserts a durable, tokenless **known-servers** entry
(`src/lib/known-servers.ts`, AsyncStorage key `audiosilo.knownServers`, NOT touched by
`resetStaleStorage`), so after a full logout the connect screen offers one-tap
"Reconnect to <server>" shortcuts (with a per-entry forget).

**Personal API keys.** The per-server account screen (`src/app/(app)/(home,library,search,offline,me)/account.tsx`)
renders an API-keys section (`src/components/account/api-keys-section.tsx` +
`use-api-keys-manager.ts`, one-time secret via `api-key-created-modal.tsx`) for
user-minted, non-expiring bearer tokens (dashboards, cron). It is **capability-gated**
(server `api_keys`) and **demo-hidden**. State is connection-scoped: hooks
(`useApiKeys`/`useCreateApiKey`/`useRevokeApiKey`) key on `qk.apiKeys(cid)`;
`client.{createApiKey,listApiKeys,revokeApiKey}` hit `/auth/tokens`. The secret is
returned once by `createApiKey` and shown in the copy-once modal (`ApiKeyCreated`);
the list is metadata-only (`ApiKey`, with `last_seen`). Strings under
`settings.apiKeys.*`.

**The book screen is tabbed.** `src/app/(app)/(home,library,search,offline,me)/book/[libraryId].tsx` shows an
**overview** (breadcrumbs, `BookVersions`, cover hero/stats/listen/`DownloadControl`,
then the meta **About** block) and puts *everything else* behind a
`Tabs` row (`src/components/ui/tabs.tsx`, the Stacks underline tabs with
`scrollable`, so the row scrolls horizontally and carries tablist/tab/tabpanel
a11y roles): **Chapters** (label
switches to "Files"; the default tab) · **Recaps** · **Characters** · **Bookmarks** ·
**History** · **Notes** · **Series**. Both layouts share the same tab section; tablet and
desktop keep a right-hand cover panel (300 / 380 wide) whose button plays inline - the docked
player bar is the transport there, so the panel never carries one (while this book plays its
button opens the full player instead). A long chapter list used to bury the
sections below it - with tabs each is one tap away, and the active panel renders
inside the page's existing ScrollView (never a nested vertical scroller). Which tabs
exist is the pure, tested `bookTabs()` (`src/components/library/book-tabs.ts`):
chapters when there's a list, the three community-metadata tabs only when that data
is non-empty (so nothing regresses on an older server or an unmatched book),
bookmarks/history/notes always (they're user-creatable, so they must be reachable
from empty - hence the `emptyLabel`; those sections render no heading of their own,
the tab label is the heading). `tab` is held as an *intent*; render falls back to
the first existing tab when data changes under it. Labels come from
`TAB_LABEL_KEY` (same module), which deliberately **reuses** the existing strings
(`library.{bookmarks,history,notes}.title`, `book.meta.characters`) - only
`book.tabs.{recaps,series}` are tab-only keys.

**Enriched book metadata.** One `useBookMeta` fetch at the screen level feeds
`matchedMeta()` and the placeable blocks exported from
`src/components/library/book-meta.tsx`: `BookMetaAbout` (description with the
6-line collapse, production details, abridged badge, "View on AudioSilo Meta" link -
in the overview, above the tabs), `BookMetaRecapsTab`, `BookMetaCharactersTab`,
`BookMetaSeriesTab`. Those take **plain data, not a query**, so a sibling block can be
appended without another restructure - which is how the **"catch up on previous books"**
block lands: `previousWorks(rails)` (pure, tested - earlier positions only, from each
rail's shown reading order, deduped, position-DESCENDING, unparsable positions dropped)
feeds one shared accordion into both the Recaps and Characters tabs, and each row
lazily fetches its own work with `useMetaWork(workId, open)` (`client.metaWork` →
`GET /meta/work?id=`, key `qk.metaWork(cid, workId)`, 1h/`retry:false`) - a closed row never fetches, and any
failure (an older server 404s, since it lacks the route) is a quiet caption + the
entry's `web_url` link, never an error. Bodies: the work's `recap_summary.in_short`
(else its furthest book-scope recap via `lastBookRecap`), and its `CharacterCard`s.
`recap_summary.ending` is a **full spoiler** - always behind its own extra tap
(`How it ends` + chip), and for the CURRENT book only offered once `progress.finished`.
`in_short` is **not** spoiler-free either: it is the whole book in one paragraph,
ending included. A previous book (whose row the reader opened deliberately) and a
finished current book show it inline under "In short"; an UNFINISHED current book
heads its Recaps tab with a collapsed `Whole-book summary` + chip row instead
(the shared `SpoilerAccordion`, which mounts its text only once opened). ONE exported
predicate, `summaryIsVisible(summary, finished)` (`in_short` - inline or as that tap
row - or an `ending` once the ending is in play), is called by the screen (feeding
both `bookTabs` and `BookMetaRecapsTab`), by `RecapSummaryBlock`'s own null-guard
and by the render tests - so a Recaps tab can never open onto a panel that withholds
everything; `bookTabs` likewise opens the Recaps/Characters tabs on `hasPreviousBooks`
alone, and counts Chapters as present while `useChapters` is still in flight (so the
row can't start on Bookmarks - firing its GET - and then snap over).
**Reading-order families** (rules in `src/lib/series-orderings.ts`, pick in
`src/stores/series-orderings.ts`): the server collapses a primary series and its
`ordering_of` variants into ONE rail (`BookMetaSeries` = main view + additive
`orderings[]`; an older server sends neither, so every series is its own family). The
reader's pick is remembered PER FAMILY, device-wide (not a scoped key). `seriesRails`
shows the picked order and `previousWorks` reads those same rails, so "previous books"
always follows the pick; a view without the current book contributes nothing (the
Narnia regression test). The collapse is server-side too so an unaware client still
gets one rail per family rather than a duplicate per reading order. Stores persisted as
one JSON document share `persistedDocument` (`@/lib/storage`): a change made before
hydration wins and never clobbers the stored rest.
Characters/recaps are the CC BY-SA layer under `work.characters`/`work.recaps`
(`BookMetaCharacter`/`BookMetaRecap`/`BookMetaPosition` in `types.ts`); pure helpers
(`roleLabelKey`/`revealFromStart`/`recapDescriptor`/`sortRecaps`/`seriesRails`/
`previousWorks`) are unit-tested. Progressive enhancement - **capability-gated** on
server `metadata` (`!!server.capabilities.metadata`, absent on older servers) and nothing renders while
loading/error/`matched:false`. `client.bookMeta` hits `/libraries/{id}/meta`;
`useBookMeta` keys on `qk.bookMeta(cid, lib, path)` (1h `staleTime`, `retry:false` so
a 502 from a down meta service doesn't spin). Strings under `book.meta.*` (plus the
two `book.tabs.*` keys) in all 6 locales. The wire envelope (`BookMeta` discriminated
union in `types.ts`) is hand-mirrored from the server.

**Player-redesign data API (Phase 1a: wire only, no UI yet).** `src/api` mirrors the
server's additive redesign endpoints, each gated on its own capability flag (absent on
older servers = false). `useCapability(flag, connectionId?)` reads a flag as `undefined`
(not known yet) / `true` / `false`, and the gated hooks give a server without the flag
no query function at all (`skipToken`), so it is never asked, not even by a manual
`refetch`: `client.authors`/`narrators` (normalised to `PeopleList {people, unknown}`)
and `seriesList` with `useAuthors`/`useNarrators`/`useSeriesList` (`browse_people`), and
`client.listBooks` with `useLibraryBooks` (a `narrator` filter waits for
`browse_people`); `client.nextBook` + `useNextBook` (`next_book`, server-resolved: community when it
places its next work, else series -> folder -> none, `source` naming who produced
`next`; a `work` without `local` is the rail's next work left unplaced; a community
`next` can be in another library);
`coverUrl(lib, path, {size, version})` (`cover_sizes`; `size` bounds the longer side;
`version` is the book's `cover_version`, sent as `v=` purely as a cache buster);
`bookMeta(..., {includePrevious, hideSpoilers})` and `useBookMeta(..., opts)`
(`meta_bundle`; each variant has its own `qk.bookMeta` key; `nextBook` and an
`includePrevious` request get the server's 30 s budget, not 15 s). `Book` gains
`published`, `description` (item only), `cover_color`, `cover_version`; `BookMetaWork`
gains `community_description` + `attribution` (render the server's text beside CC BY-SA
content), rail entries `local`, the recording `chapter_count`. Nothing consumes them yet:
Phase 2+ of PLAYER-REDESIGN-PLAN.md does, so the screens above still gate spoilers and
pick the next book on the device.

**Player-redesign user state (Phase 1b: wire only, no UI yet).** Same pattern, six more
flags: `queue` (`useQueue` + set/add/remove), `collections` (`useCollections`,
`useCollection(id)`, `useShareTargets(enabled)` - pass false for demo accounts, which
get a 403 - and the collection/items/shares mutations; read-only sharing, a viewer's
`shared_with` is absent), `ratings` (`useRating`, `useMyRatings`, set/delete; a PUT
replaces the whole rating, so an omitted `note` clears it), `progress_edit`
(`useEditProgress`: PATCH dates / mark unfinished; it does NOT touch the local progress
mirror or offline queue, decision 7), `user_stats` (`useMyStats(range)`,
`useMyListening(range)`, `useListeningGoal` + set/clear; server time) and `my_devices`
(`useMyDevices`, `useRevokeMyDevice`: `current: true` means this device's token is dead,
so the caller signs out locally). **Mutations check their flag at call time** and reject
with `CapabilityError` (not an `ApiError`, so no reconnect banner) without sending
anything when the flag is false or `/server` hasn't answered yet. Gating tests live in
`hooks-capability.test.tsx`; each was checked to fail with its gate removed.

**Spoiler gating by listening progress** (`src/components/library/meta-gating.ts`,
all pure + tested). The listener's position is a 1-based chapter NUMBER derived
from **ONE whole-book POSITION** - the player's live position
(`usePlayer(selectBookPosition)`) when this book is loaded, else `useBookProgress`
(`qk.progress(cid, lib, path)`) - walked through `chapterNumberAt` against the
screen's *corrected*, memoized chapter offsets (`chapterStarts`, recomputed from the
cumulative file durations, not the server's `book_offset`); no position → 0. **Never
the player's chapter identity**: a chapterless single-file book gets *synthetic*
30-minute chapters (`synthesizeChapters`) whose indexes are wall-clock slices, so
reading them as logical chapter numbers revealed the whole cast an hour in. The
consequence is that a chapterless book gates to 0 whether playing or not (accepted -
"Show anyway" is the escape hatch). The live position is sampled in coarse buckets
(`LIVE_POSITION_BUCKET_S`) so the screen re-renders at chapter-ish granularity
rather than per tick; rounding DOWN can only delay a reveal, never reveal early.
That progress query rides the SAME gate as the metadata itself
(the screen passes `bookMetaEnabled`, so there's no wasted GET where nothing is
gated). Its `queryFn` falls back to the durable local mirror (`mirroredProgress` in
`progress-sync.ts`) **only for a non-`ApiError` failure** (offline/unreachable, and
it `noteError`s reachability like `loadInitialProgress` does) - an `ApiError` means
the server ANSWERED and is rethrown, because resolving a 401 as a query *success*
on `qk.progress` would have `provider.tsx`'s `QueryCache.onSuccess` immediately
`clearNeedsReconnect()` the banner that same request just raised. A character shows when `reveal.chapter <= max(current, 1)` (an
unstarted book still shows the from-the-start cast); a recap when
`through.chapter === 0` or `through.chapter < current` (a chapter is only "done"
once you're past it); `finished` reveals everything. Meta chapter numbers are the
*work's* logical chapters and needn't match the local edition - the comparison is
deliberately approximate. Not-yet-reached entries are **not rendered**; each tab
footers a quiet "N hidden to avoid spoilers" + **Show anyway** toggle that renders
them marked with a `Spoiler` chip. The reveal is ONE piece of state held by the
**screen** and passed to both tabs (`showSpoilers`/`onToggleSpoilers`) - revealing in
Characters and switching to Recaps must not re-hide what the reader just chose to
see. Descriptions/recap text stay behind their own per-card accordions either way.

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

**Styling**: use `className` on core RN components (**Uniwind**, Tailwind v4; Metro wires
it in via `withUniwindConfig` in `metro.config.js`, so there is no babel preset). Never
import an icon lib directly - use `<Icon name=... />` (`src/components/ui/icon.tsx`). Text
via `<Text variant=... />`. **[STYLEGUIDE.md](STYLEGUIDE.md) (Stacks) is authoritative** for
tokens, type and components; its section 17 maps them onto these files.
- **Primitives are react-native-reusables** (`components.json`, Uniwind) in `src/components/ui/`,
  restyled to Stacks (list: STYLEGUIDE.md section 17, "Components in this codebase"). Add more with
  `npx @react-native-reusables/cli add <name> --styling-library uniwind -p <scratch dir>` (it would
  overwrite our same-named files), then port: lucide -> `<Icon>`, strings through `t()`, the
  Stacks tokens (shadcn's `bg-black/50`, `text-zinc-*`... compile to nothing here), `rounded-control`
  etc. Overlays (Dialog, AlertDialog, Select, Popover, DropdownMenu, Tooltip) portal into the root
  `<PortalHost />` on native (keep it LAST in `src/app/_layout.tsx`) and wrap in `FullWindowOverlay` on
  iOS, so they can open from inside a card or a ScrollView. Keep exactly one `@rn-primitives/portal`
  and one `@radix-ui/react-slot` (`npm ls`); the `@rn-primitives/*` family is pinned `~1.5.x` to move
  together. Overlays read the WINDOW's safe-area insets: `RootInsetsProvider` (`overlay.tsx`, mounted
  once directly inside the root `SafeAreaProvider`) captures them, and `useOverlayInsets` /
  `useDialogFrame` read them (`useRootInsets`), so the call site doesn't matter - a tab page's own
  context counts the native tab bar in `insets.bottom`, which made phone sheets ~100pt too tall and
  pushed menus up on iOS. Dialog and AlertDialog share one `DialogFrame`. On web, rn-primitives hands
  Content's props to Radix DOM nodes through a Slot that merges `style` by object spread (an array
  crashed react-native-web's style setter): every Content part is wrapped once in `withFlatStyle`
  (`overlay.tsx`), so a style array is fine at the call site. Tests render overlays with
  `mountWithPortal` (`src/testing/render-overlay.tsx`, which adds the RootInsetsProvider too).
- **Web keyboard (Space):** `src/lib/rnw-button-fix.web.ts` (imported first by the root layout) also
  patches react-native-web's press responder: Space presses any role-bearing pressable (`tab`, `radio`,
  `switch`, `checkbox`, `option`, menu items; RNW only did `button`), and a `role="button"` pressable
  with no `onPress` leaves Space to its own handlers (so Radix opens a Select). No per-primitive Space
  shims.
- **Colour tokens are the Stacks semantic tokens, with ONE source, `src/theme/tokens.json`**
  (`themes.light` / `themes.dark`, plus a fixed `palette` of `white`/`black`). `npm run gen:tokens`
  (`scripts/gen-tokens.mjs`) writes the generated region of `src/global.css` (each theme token as a
  Uniwind theme variable, `--color-<name>` under `@variant light` / `@variant dark`) and
  `src/theme/tokens.ts` (`colors.light.<camelName>` / `colors.dark.<camelName>`, `colors.white`).
  Never hand-edit either output: `npm test` runs `gen-tokens.mjs --check` (and the generator's
  unit tests) first and fails on drift. The `palette` holds plain colours only (no shade families or
  aliases).
  - Use the semantic classes, which follow the theme on web AND native with **no `dark:` pair**:
    page `bg-background`, surfaces `bg-card` (sheets/dialogs `bg-popover`), quiet fills and tracks
    `bg-muted`, text `text-foreground` / `text-muted-foreground` / `text-subtle-foreground`,
    hairlines `border-border`, pressed/hover `bg-accent`, status `text-destructive` / `success` /
    `warning` / `info`. Opacity modifiers work (`bg-brand/10`).
  - **`primary` is ink** (shadcn): the primary button / play button colour. **The pink is
    `brand`**: fills, progress, selection `bg-brand` (+ `text-brand-foreground` on it), pink text
    `text-brand-ink` (AA), tinted fills `bg-brand/10` or `bg-brand-soft`. One pink thing per view.
  - **Tailwind's default palette is switched off** (`--color-*: initial` in the generated region),
    so `bg-gray-200` / `text-red-500` compile to nothing. Add a token to `tokens.json` (both
    themes) instead.
  - Native props that need a colour string read `useThemeColors()` (`@/theme/use-theme-colors`),
    which returns the resolved theme's `colors.light|dark` from a context `ThemeProvider` fills (one
    `useUniwind` subscription, not one per Icon); don't pick `scheme === 'dark' ? ... : ...`.
- **Fonts (Stacks):** Figtree (body), Bricolage Grotesque (display), JetBrains Mono, loaded by
  `ThemeProvider` from `@expo-google-fonts/*` (only the weights a token uses). One family per token,
  since RN has no font fallback or synthetic weights (web adds the system stack): `font-sans` (Figtree
  400), `font-sans-medium`, `font-sans-semibold`, `font-sans-bold`, `font-display` (Bricolage 700),
  `font-display-semibold`, `font-mono` (JetBrains Mono 500). Figtree and Bricolage gate first paint
  (the splash); JetBrains Mono loads alongside without gating (system mono until then). Never pair a
  font token with `font-medium`/`font-bold`.
- **`<Text>` variants are the Stacks type roles:** `display-xl`, `display`, `heading`, `title`,
  `body` (default), `muted`, `label` (Figtree semibold, list-row titles; was `subtitle`), `caption`,
  `eyebrow` (uppercase kicker; was `label`), `mono`, `stat` (`mono`/`stat` add tabular figures).
- `metro.config.js` and `scripts/check-styles.cjs` read the same Uniwind options (`uniwind.config.js`),
  so the guard compiles exactly what Metro does.
- `src/global.css` also pins v3-era values on purpose - NativeWind's `shadow-xs` /
  `shadow-lg` values (the two the app uses; any other `shadow-*` is Tailwind v4's default
  until it is pinned the same way), px breakpoints, `rounded-full` = 9999px, native px
  letter-spacing (`tracking-*`), v3 `hover:` (no `(hover: hover)` gate), v3 preflight
  compat, and a `dark:` variant that still applies in browsers without CSS `@scope`
  (Uniwind scopes `dark:` rules on web) - Phase 0a was a no-visual-change migration.
  `scripts/check-styles.cjs` (run by `npm test`) guards these through Uniwind's real compiler:
  an unscoped web `dark:` rule, native `tracking-wider` = 0.5, and the themed tokens resolving
  per theme on iOS and switching under `.dark` on web.
- **rem is 14px on native** (`polyfills.rem` in `metro.config.js`, NativeWind's value);
  web uses real CSS rems against the browser's 16px root.
- **Theme**: `ThemeProvider` drives `Uniwind.setTheme('light'|'dark'|'system')` and reads
  the resolved scheme from `useUniwind()`; `useTheme().scheme` is that resolved value.
  **Default (owner decision 2026-10-05, "System, new installs only"):** a new install follows
  the OS (`system`); an existing install (`hasExistingInstall` in `src/stores/session.ts`: a
  persisted connection, a known server, or a legacy session) that never chose a theme gets
  `dark` written once to `audiosilo.theme`. Explicit picks are untouched; an unknown stored value
  reads as `dark` and is not written. The default is a step of the memoised launch migration
  (`migrateStorage`, `src/lib/storage-migration.ts`): only when no pref is stored, it reads
  `hasExistingInstall` BEFORE `resetStaleStorage` and writes `defaultSchemePref`; ThemeProvider awaits
  the same run, then only reads `audiosilo.theme` (`restoredSchemePref`, `src/theme/scheme-pref.ts`).
  `useTheme().toggleScheme()` flips light/dark (the profile menu, the palette). The
  static web shell (`+html.tsx`) paints the OS scheme's background before mount.
- **Conflicting classes are not de-duplicated.** When two classes with the same variants
  set the same property, web resolves by stylesheet order and native by className order
  (the later class wins). A class with a variant (`dark:`, `active:`, `ios:`, `md:`...)
  outranks a plain one on every platform, whatever the order. A component that lets a
  caller override its classes must merge with `cn()` (`@/lib/utils`, clsx +
  tailwind-merge: a caller class replaces the component's class for the same property
  AND variant). The themed `<Text>` does; its variants use themed tokens (no `dark:`
  half), so `<Text variant="caption" className="text-brand-ink">` recolours both themes.
- **Web cascade layers** (`src/app/+html.tsx` + the split Tailwind imports at the top of
  `src/global.css`): Tailwind's utilities are imported unlayered and the layer order puts
  react-native-web's resets above Tailwind's preflight, reproducing Tailwind v3's
  precedence. Keep both when touching either file.
- `src/uniwind-types.d.ts` is generated by Uniwind (Metro, or `npx uniwind
  generate-artifacts --css ./src/global.css --dts ./src/uniwind-types.d.ts`) and committed
  so `tsc` passes without Metro; it gives RN components their `className` props.
- **`className` only works on React Native's own components** (Uniwind's Metro resolver
  swaps those). A third-party component needs a one-time `withUniwind` wrapper - e.g.
  `SafeAreaView` from `@/components/ui/safe-area-view` (lint forbids importing it from
  react-native-safe-area-context, whose classes are silently dropped on native;
  NativeWind used to wrap it for us).
- **Native shadows** mirror NativeWind's legacy output (see the notes in `src/global.css`):
  iOS draws `shadow-xs`/`shadow-lg` as a box-shadow with doubled blur, Android uses
  `elevation`. A shadowed `overflow-hidden` view adds `ios-clipped-shadow`. Frame
  shadowed cover art with `CoverFrame` (`@/components/library/cover-frame`, `size` xs/lg
  + layout `className`), which owns the frame classes and the iOS inline shadow they
  need; the two shadowless thumbnail frames (book-meta's previous-book rows, the
  downloads list) keep their own classes.
- Uniwind's free tier has no `group-*` variants and no `hover:` on native.
Raw color values for native props: `useThemeColors()` (themed) or `colors.white`/`colors.black`
from `src/theme/tokens.ts`.

**Routing**: `src/app/(app)/*` is the authenticated app (guarded by `<AuthGate>`,
`src/components/shell/auth-gate.tsx`, in both platform layouts); `src/app/connect/*` is
onboarding; `src/app/player.tsx` / `finished.tsx` are root full-screen modals. **ONE route tree
on every platform**, five tab groups under `(app)`:
```
src/app/(app)/_layout.tsx        native: NativeTabs (5 triggers + BottomAccessory), hidden on tablet/desktop; the one floating mini player
src/app/(app)/_layout.web.tsx    web: headless expo-router/ui Tabs + our chrome around ONE <TabSlot/>
src/app/(app)/(home)/index.tsx                  /
src/app/(app)/(library)/library/index.tsx       /library
src/app/(app)/(search)/search.tsx               /search
src/app/(app)/(offline)/downloads.tsx           /downloads
src/app/(app)/(me)/settings.tsx                 /settings   (the "Me" tab; the Me hub is Phase 5)
src/app/(app)/(home,library,search,offline,me)/_layout.tsx    one Stack per tab (array group)
src/app/(app)/(home,library,search,offline,me)/{book/[libraryId],library/[libraryId],library/favourites,account,browse}.tsx
```
Groups are invisible in URLs, so every URL is unchanged. The destinations (labels, icons,
SF Symbols / Material names, tab roots) are one table, `src/components/shell/destinations.ts`.
- **The pushing tab owns a detail page** (a book pushed from Search stays in Search; back
  returns there): the shared detail routes live once in the array group, and expo-router
  resolves a push against the current segments.
- **Cold deep link owner = Home.** A cold `/book/...` is given to the alphabetically FIRST tab
  group, which is why Downloads is `(offline)`, not `(downloads)`. The array-group layout's
  group-keyed `unstable_settings` (`TAB_STACK_SETTINGS`) insert each tab's root underneath, so
  back works; `tabStackListeners` strips the link params React Navigation copies onto that root
  and its ancestors (else back landed on `/?libraryId=1`).
- **Tab presses from our chrome dispatch `JUMP_TO`** (`useTabPress`): another tab -
  `navigationRef.dispatch({ type: 'JUMP_TO', payload: { name: '(library)' } })`, which restores
  its stack; a href can't (`router.navigate('/(home)')` resolves to `/` and pops Home). The
  active tab again - `router.navigate(<its root>)`, pop to top.
- **Web: `<TabSlot/>` stays at a FIXED ancestor path at every width**; only sibling chrome
  toggles (moving it remounts every screen and jumps the URL on resize). **Native: never add or
  remove tabs at runtime**; tablet/desktop toggle `NativeTabs hidden` (state survives).
- Onboarding returns with `leaveOnboarding()` (`src/components/shell/leave-onboarding.tsx`,
  `router.dismissTo('/')`; `<LeaveOnboarding />` at render time), never `replace` or `<Redirect href="/">`
  (also a replace): `(app)` is the root stack's `anchor` and already sits under `/connect`, so a replace
  stacked a second `(app)`. The
  "signed in, nothing to add" bounce lives in `connect/index.tsx` (its own params), not the
  connect layout, whose `useGlobalSearchParams` misses a warm link's params on first render.
- Regression net: `src/components/shell/route-tree*.test.tsx` drive expo-router's
  `renderRouter` over the REAL `src/app` file list (`src/testing/route-tree.tsx`).

Content routes are **flat** - `library/[libraryId].tsx` (re-exports
`src/components/library/browse-screen.tsx`), `book/[libraryId].tsx`, `account.tsx` -
and carry **both the connection and the library-relative path as query params**
(`/book/[libraryId]?connection=<cid>&path=<rel>`). The connection is NOT a
`/s/[connectionId]/` route segment: `router.push` (React Navigation's `linkTo`) can't
resolve a tap into a route nested under a dynamic layout segment - it lands on the
group's first child - whereas a flat route + query param pushes correctly (a direct URL
load worked either way via `getStateFromPath`, which is why the bug only bit in-app
navigation). Each content screen scopes itself to its `?connection=` with
`<ContentScope>` (its own local param); the content hooks read it via `useScopedCid()`.
Path helpers + the full rationale are in `src/lib/paths.ts`.

**Shell** (`src/components/shell/`): `useLayout()` (`src/lib/layout.ts`) is the one form-factor
switch - `phone` < 640, `tablet` 640-1023, `desktop` >= 1024 (pure `layoutFor`); never compare a
width yourself. It is a store over `Dimensions` that yields the class, so a consumer re-renders only
when the window crosses a threshold. Both platform layouts wrap their one navigator in `ShellFrame`
(`shell-frame.tsx`); the page column is `CONTENT_WIDTH` (`src/lib/layout.ts`). Phone: tab bar (native on iOS/Android, `PhoneTabBar` on web), each page's Stack
`header` is `PhoneHeader` (large title on a tab root, inline back named after the parent on iOS,
banners under it), the mini player in the iOS 26 tab bar's bottom accessory (`AccessoryPlayer`,
rendered twice by iOS - `regular` + `inline` - so it is stateless and reads the player store) or a
floating `MiniPlayer` card elsewhere (`ACCESSORY_SUPPORTED`). On native that card is ONE
`FloatingMiniPlayer`, rendered by `(app)/_layout.tsx` as the shell frame's `phoneBottom` over
NativeTabs (never per tab stack: NativeTabs keeps visited tabs alive, so a card per stack ticked up to
five times), absolutely positioned on the native bar's measured `bar` edge, so it sits on the bar on
every tab and over pushed pages and a tab switch never remounts it; web puts its card on its own tab
bar. Tablet/desktop (web and native):
`TopBar` (64; mark + server line, Home/Library/Downloads, omnisearch, settings, `ProfileMenu`),
`SubNav` (50; title on a tab root, Back on a pushed page; tab roots leave their title to the
chrome), banners, the page capped at 1480 (`CONTENT_WIDTH`), a closed `DrawerSlot` on desktop (Up next fills it in
Phase 2), and `DockedPlayer` (84) whenever a book is loaded (it mounts its speed/sleep sheets as
siblings so they cover the app). Route-driven side effects (search reset on leaving the Search
tab, browse scroll memory) are `useShellEffects`.
- **Command palette (web only)**: `CommandPalette` (`command-palette.tsx`), mounted once by the web
  shell on the Dialog primitive, opened by the omnisearch (web tablet/desktop; a native tablet's
  omnisearch still jumps to the Search tab and focuses it), ⌘K / Ctrl+K or `/` (`usePaletteShortcut`:
  never while typing in a field, over another dialog, or over the player modal). State (open, query,
  recent searches persisted per device under `audiosilo.paletteRecent`) is `usePalette`
  (`palette-store.ts`); which items show, the grouping, the arrow-key clamp and the shortcut test are
  the pure `palette-model.ts`. Content is only what exists: Actions (pause / "Resume <chapter>",
  sleep in 30 minutes, sleep at end of chapter - only with real chapters -, open the full player, go
  to settings, switch light/dark), Books from `useSearchAll` (debounced, `useDebouncedValue`; sources
  from `useSourceLabeller`; empty query: Continue listening from the cached `useAllProgressAll` with
  `refetchOnMount: false`, disabled while a query is typed, `isInProgress` shared with Home), Go to (the
  top bar's destinations, `TOP_BAR_TABS`, already filtered to what this browser can do). A book opens
  with a plain push, so it lands in the current tab. Authors, series, narrators and characters wait
  for Phase 2.
- **Profile menu** (`profile-menu.tsx`, tablet/desktop top bar): each server with its state
  (`serverStatus` in `src/api/reachability.ts`, also the top bar's server line and the dock's
  saved-locally line: needs signing in again > offline > signed in as), opening its account screen;
  Add a server (`/connect?add=1`); the account on the default server; a light/dark switch. Phone
  keeps these in the Me tab.
- **Toasts** clear the bottom chrome: each piece publishes its measured TOP edge (distance from the
  window's bottom) into `useShellMetrics` with `useChromeEdge` - `bar` (the web tab bar by layout; the
  native bar from the tab stacks' layout: iOS's bottom inset there, Android's gap between the page's
  and the shell frame's bottoms, both from `measureInWindow` (`nativeBarEdge`; Android's
  `measureInWindow` is offset by the status bar under edge-to-edge, so comparing with the window
  height made the bar a status bar too tall); each stack publishes only once it has measured),
  `mini` (the floating card: bar + its height), `accessory` (the iOS 26 pill, measured in the window),
  `dock` - and the root `ShellToastHost` passes `<ToastHost bottomInset>` from the pure
  `toastBottomOffset` over `bottomChromeTop` (the highest piece; one fallback before the first layout;
  tablet/desktop with nothing loaded and over a root modal: just above the home indicator). The web mini
  player sits on its tab bar through a `100%` bottom offset, no measured height. The accessory renders
  nothing on tablet/desktop (iOS mounts both placements behind the hidden bar).
- **Banners**: `OfflineBanner` takes the page's connection as a prop (each phone header its own
  route's `?connection=`, the wide `WideTop` the focused page's) and selects only which message shows.

## Layout
```
src/app/            Expo Router routes ((app) tab groups, connect/, player + finished modals)
src/api/            client.ts, types.ts, hooks.ts (React Query), provider.tsx
src/playback/       PlaybackService + web/native engines, store, book-queue, progress-sync
src/downloads/      offline downloads: native/web engines + store (sibling of playback)
src/components/      ui/ (primitives + Icon), shell/ (tabs, top bar, dock, headers), layout/ (banners, ContentScope), player/, library/
src/stores/         Zustand: session, search, settings, series-orderings
src/i18n/           i18next setup, language provider, locale JSONs (locales/)
src/theme/          tokens (tokens.json source -> generated tokens.ts) + ThemeProvider
src/lib/            storage, secure-store, device, paths, format, register-sw
```

@AGENTS.md
