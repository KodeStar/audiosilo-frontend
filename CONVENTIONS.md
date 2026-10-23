# AudioSilo Frontend - architecture & conventions

Moved verbatim out of CLAUDE.md so it is read on demand instead of loading into
every session. CLAUDE.md keeps a one-line index of these topics.

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
onto another. **A connection is one user on one server**, so its id is
`<server_id>.<user_id>` (`connectionIdOf`, `src/lib/connection-id.ts`; two people signed in to
one server are two connections with their own tokens, downloads, progress and cache). Never
split an id yourself, never compare one with a `server_id` (compare servers through
`serverIdOf(conn)`), and keep every id-keyed document's key in `src/lib/storage-keys.ts` (one
leaf module the launch-time migrations read without importing the stores; add a new
connection-keyed document to `ID_DOCUMENTS` in the identity migration too). The seam is `src/api/connection-clients.ts` - framework-free modules
(progress-sync, the downloads store) resolve a connection id to its `ApiClient`
(`resolveClient`) and gate on the session having hydrated (`sessionReady`) before
reading storage, without importing React; removing/signing out of a connection
**purges** its scoped state through the `onConnectionRemoved` registry in
`src/stores/session.ts`. Stale persisted state is reconciled once, before any store
hydrates, by `resetStaleStorage()` (run inside the memoised launch migration `migrateStorage()`,
`src/lib/storage-migration.ts`, which `bootstrapPlayback` (the launch steps, below) and ThemeProvider both await) along **two independent version axes** so cache churn
can never log anyone out (`{ authReset, cacheReset }`):
- **`AUTH_STORAGE_VERSION`** gates the auth wipe (connections + their secure-store session
  tokens). Session tokens never expire server-side, so wiping them is the ONLY thing that
  logs a user out and forces a re-pair. Bump it **ONLY** when the connection *identity
  scheme itself* changes AND can't be re-keyed (like v2: ids became the server-minted
  `server_id`) - a deliberate, rare, breaking act that logs **everyone** out. **Never bump it
  for a cache reason**, and not for an identity change that can be re-keyed: Phase 8's
  `<server_id>.<user_id>` ids moved every connection with the identity migration (below) and
  nobody was signed out.
- **`CACHE_STORAGE_VERSION`** gates the disposable per-server cache (downloads + the
  progress mirror/queue + the on-disk downloads root). Bump **this** for any scoped-state /
  cache schema change: it wipes that cache (it re-downloads / re-syncs from the server)
  while keeping every login intact. A pre-existing install that predates this split adopts
  the cache version silently, without wiping its downloads.

**The launch steps are ONE memoised run, `bootstrapPlayback()` (`src/lib/bootstrap.ts`)**: the
storage migration, then the downloads-root wipe (`engine.clearAll()`) when **either** axis reset,
then hydrating the session, settings, downloads, series orderings and library selection, with the
listener's language applied alongside. The root layout calls it before any screen, and so does the
Android car's headless task (Car below), which has no layout; a later activity on the same JS
runtime finds it done. Add a new launch step there, never in `_layout.tsx` alone, or the car runs
without it.
`migrateStorage()` first writes the theme default (see Theme below), so the existing-install signal is read
before the reset can rewrite the session keys - no effect-order contract.
See `src/api/client.ts` + `src/api/types.ts`.

**Connection identity migration (Phase 8, `src/lib/identity-migration.ts`)**, run by `migrateStorage()`
after the reset and before any store hydrates: every connection saved with a legacy id (the bare
`server_id`) moves to `<server_id>.<user_id>` with everything keyed by it (`ID_DOCUMENTS`), and
nobody is signed out. Tokens are copied and read back first (any failure, such as a CarPlay launch
with the phone locked, aborts with nothing changed); then the plan is stored
(`audiosilo.identityPlan`) and from there it only goes **forward**: native download folders move
(`engine.moveConnection`, never reversed), every document is rewritten in one `setMany`, the
aliases (`{ legacyId: newId }`, `audiosilo.connectionAliases`, never wiped) and the first profiles
document are written, the version is recorded, and only then are the old tokens and the plan
deleted. Every rewrite maps through the plan, so a run cut short is finished by the next with the
same plan; `migrateStorage` retries a few times holding every reader, then gives up for this launch
with `identityMovePending` set, so downloads and the offline queue keep what names an id no
connection has yet instead of pruning it. Nothing moves while the Android service holds a book of
a connection being moved (`busy`). A connection with no usable `user.id` stays legacy, and a
legacy id must keep working everywhere (`Connection.serverId` is optional for it: read it through
`serverIdOf`). **Old ids arriving from outside** (a widget link, a car snapshot item, a bookmark
the Android service queued, web history) go through `resolveConnectionId` (`connectionParam` does
it for routes; `resolveClient` too, as a safety net). **The web moves no files**: the Cache API
can't rename, so `engine.web.ts` keeps a moved connection's files under its legacy id
(`legacyIdOf`) while the registry uses the new one.

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
response whose `server_id` differs from the connection's (`serverIdOf`) flags `server-reset`
(that public success is skipped for flag-clearing, since it proves nothing about the token).

The flag is a per-connection `Connection.needsReconnect?: 'auth' | 'server-reset'` in
`src/stores/session.ts` (`markNeedsReconnect`/`clearNeedsReconnect`) - **in-memory only**
(stripped from the persisted shape, recomputed from the next failure), and marking it
never removes the connection or its token (only a successful `setSession` re-pair replaces
the token) - and `markNeedsReconnect` never downgrades a `server-reset` flag to `auth`, so
frequent authed 401s can't clobber the rarer, more informative server-reset reason. A
re-pair of a reset server (a *stale same-URL connection under a different `server_id`*,
`staleIdentities`) retires **only the signer's own** stale identity (`setSession({ retire })`;
`finishConnect` names them with `staleToRetire`: the reconnect banner's person, else the person
listening, nobody's for "Add someone"): its dead token and scoped state go through the
`onConnectionRemoved` registry, and the new connection takes its place in that person's profile
(`onConnectionReplaced`, so their PIN and kids settings stay). Every other person's stale
identity stays, flagged `server-reset`, for them to sign in again: never delete another person
from the device. A kids profile never runs the connect flow (`connect/_layout.tsx` is the only
gate, Phase 8b-1): a grown-up signs it in again. It surfaces as a slim accent bar (`src/components/layout/reconnect-banner.tsx`,
rendered by the shell beside the offline banner - under the phone header, or under the top bar
on tablet/desktop); tapping it pre-fills `pendingServerUrl`
and routes into the EXISTING connect → sign-in screens to re-enter a code/password.
`setSession` also upserts a durable, tokenless **known-servers** entry
(`src/lib/known-servers.ts`, AsyncStorage key `audiosilo.knownServers`, NOT touched by
`resetStaleStorage`), so after a full logout the connect screen offers one-tap
"Reconnect to <server>" shortcuts (with a per-entry forget).

**Home and away addresses (Phase 5, capability `addresses`).** A connection keeps the server's
`addresses: { home?, away? }` (persisted with its metadata, no storage-version bump). Addresses are
cleaned once where they arrive (`parsePairingScan`, and the `ApiClient` methods that return them);
`setSession` merges what a pairing link, redeem payload, exchange or login says and keeps the prior
value when absent, and `learnAddresses` does the same for a `GET /addresses` answer;
`mergeAddresses` (`src/lib/server-address.ts`) keeps a known `home` an answer lacks, because the
server derives home from the request (an answer read through the away address can't know it).
`serverUrl` stays what the user paired with and is never rewritten. Which address requests go to is
an in-memory pick (`src/api/address-route.ts`: `useAddressRoute`, `effectiveUrl(c)`, and
`useActiveAddress(cid)` plus `ADDRESS_KIND_LABEL`/`ADDRESS_IN_USE_LABEL` for UI); `ApiProvider` and
`resolveClient` are the only places that build a connection client and both use it, so never build
one from `serverUrl`. The pick rule is pure (`pickAddress`): home only when a tokenless
`GET <home>/api/v1/server` (`probeServerId`, `src/api/server-id-probe.ts`) answers with this
connection's `server_id` (another box at the same private IP must never get the token), else away,
else `serverUrl`; the web never switches (the served player is same-origin). The runner
(`src/api/address-runner.ts`, `startAddressRouting` from the root layout, native only) re-picks at
launch, on foreground, on a network change and when reachability marks a connection offline, asks
home again every `HOME_RECHECK_MS` in the foreground (away, to come home; on home, to notice it
stopped answering, since an idle app sends nothing else that would fail), drops a
home pick at once when the device moves network, refreshes `GET /addresses` (`useServerAddresses`
is the hook form), and restarts a streamed book still playing from a previous address in place
through `startBookInPlace` (never a paused one). `parsePairingScan` returns `addresses` from
`home=`/`away=` on both link carriers. The known-servers entry keeps the addresses too
(the session hands `remember` / `rememberAddresses` what it merged, and `setSession` falls back to
them when signing in again after signing out), and a "Reconnect to <server>" row on native signs in
through the home address when it answers as that server (`reconnectAddress`). The "At home and
away" card is ONE component, `AddressesCard` (`src/components/layout/addresses-card.tsx`): connect
shows it when the server has both addresses, Account shows whichever it knows and, on native, the
one in use (`inUse`); the web passes no `inUse` and says only what the addresses are for.

**Connect and onboarding** (`src/components/connect/`, routes `src/app/connect/{index,sign-in,ready,scan}.tsx`):
every way in (pairing link or QR, invite code, password, demo) ends in `finishConnect`, which
stores the connection with the server's name and the addresses the link (`linkAddresses`) and the
answer taught, merged there once, and shows `/connect/ready?connection=` ("Your library is
ready.") only for the device's first connection; an added server goes back with `leaveOnboarding()`. A
link naming a book (`book=<library_id>&path=<rel_path>` + `uid`, the admin console's "Listen in
player": `parseConnectBook`, carried on `PairingScan` as `book` + `userId` by the route and a pasted
link alike) ends on that book instead (`endConnect`, the one ending `finishConnect` shares: a
`dismissTo` of `bookHref`, never a URL from the link), and `useLinkPairing.pair` skips the exchange
when the device is already signed in as `uid` on `sid` (`signedInAs`) and the server still takes
that stored token (`stillSignedIn`: `GET /me` through the connection's own client, never the
link's base; `needsReconnect` is never stored, so a fresh tab can't tell otherwise), never for
"Add someone"; an invalid `book` is ignored. A
pairing link whose https base can't connect (a server on its own self-signed certificate) exchanges
once at the link's `home` instead (native only): only when that is plain http on the base's own
host and port, never after an `ApiError` or a timeout, and only when the link names the server
(`sid=<server_id>`, `PairingScan.serverId`; an older server's link has none, so no fallback) and
home, asked with no token (`probeServerId`), answers as exactly that server (`pairingFallback`); a
session another server issues there is not kept. The token crosses the network in the clear, so
it goes to that server only. The connection is still stored with the https base as its `serverUrl`
(the address used when home is not an option fails safely by TLS on another network, where a
plain-http address could be another box), and `finishConnect`'s `answeredAt` makes home its first
address pick so the first requests go there; the address runner re-checks it as any home pick.
Android allows cleartext for it (`expo-build-properties` `android.usesCleartextTraffic`).
iOS does NOT allow arbitrary loads: Expo's ATS default is `NSAllowsArbitraryLoads: false` with
`NSAllowsLocalNetworking: true`, so plain http works there for IP addresses, `.local` and
single-label names, but not for a `.lan`, `.home.arpa` or `.internal` home. `repairPlan`: a
re-pair through one of a connection's own addresses keeps its paired `serverUrl`; the reconnect
banner signs in through `effectiveUrl` and passes `reconnect=<cid>`, so a reset server reached
through its away address still retires its dead identity. `/connect` decides its "nothing to add"
bounce when it opens and when it is back on top, never while the flow is over it; `sign-in` reads
`pendingServerUrl` once. The connect screens are full screens: `ConnectFrame` shrinks its column by
the keyboard overlap and `ConnectInput` scrolls the focused field into view (use both for any new
field there; Android edge to edge doesn't resize the window). The cascade panel is generated art:
never put fake titles on it. **The served player** (`servedOrigin()`, `src/lib/base-url.ts`: a
production web build, whose origin IS the server and whose CSP, `connect-src 'self'`, reaches no
other) asks for no address: `/connect` asks its own origin who it is and shows the found card
(Sign in, Try the demo) with no field or remembered servers, falling back to the field filled with
the origin only when that fails; "Add a server" (profile menu, Account) is hidden while every
connection is that origin (`onlyOwnServer`: a production build on a static host of its own, beside
servers whose CORS let it in, still adds them) and the sign-in step's "Another server" reads "Back"
and goes back (to the card, or to the app the reconnect banner was tapped in). Metro dev
(`npm run web`) is not the server and keeps the field.

**Account page (Phase 5).** One server's account is `AccountSection({ connectionId? })`
(`src/components/account/account-section.tsx`): the `/account?connection=<cid>` route renders it,
with a breadcrumb only when the page under it is one the crumb can name (Settings, or a You hub
section: `accountParentKey`; from the profile menu or a cold link the chrome's own Back is the way
back); the phone You hub's Account segment renders it without an id (the default server, with a
server switcher when several are signed in). It is a non-scrolling column: the host scrolls it
(`TabPageScroll`). Blocks, each gated on its capability: identity (the session count needs
`my_devices`), password (hidden for demo; set/change in a dialog that lifts above the keyboard), pair
another device (`api.pair()`: QR, a 10-minute countdown from arrival, Copy link on web, Share on
native), "At home and away" (`addresses`, above), signed-in devices (`my_devices`; sessions only,
each with a glyph from `deviceGlyph`: laptop for a browser, tablet when its name says so, else
phone), personal API keys (`api_keys`; a notice when the flag is false; hidden for demo), sign out
of the server. **The current device's row never offers a sign-out** (`canRevoke` refuses
`current`); this device signs out only through `useSignOut` (teardown first). Pure helpers in
`account-model.ts`.

**Personal API keys.** The account page (`AccountSection`, above)
renders an API-keys section (`src/components/account/api-keys-section.tsx` +
`use-api-keys-manager.ts`, one-time secret via `api-key-created-modal.tsx`) for
user-minted, non-expiring bearer tokens (dashboards, cron). It is **capability-gated**
(server `api_keys`) and **demo-hidden**. State is connection-scoped: hooks
(`useApiKeys`/`useCreateApiKey`/`useRevokeApiKey`) key on `qk.apiKeys(cid)`;
`client.{createApiKey,listApiKeys,revokeApiKey}` hit `/auth/tokens`. The secret is
returned once by `createApiKey` and shown in the copy-once modal (`ApiKeyCreated`);
the list is metadata-only (`ApiKey`, with `last_seen`). Strings under
`settings.apiKeys.*`.

**Profiles and PIN (Phase 8, `src/stores/profiles.ts`, `src/components/profiles/`).** A profile
is a PERSON on this device: a device-local group of connections, at most one per server, with an
optional 4-digit PIN and kids mode. One document, `audiosilo.profiles` (the identity migration
writes the first, `initialProfiles`), hydrated in `bootstrapPlayback()` and kept consistent with
the session by `reconcileProfiles` (a removed connection leaves its profile, an empty profile is
deleted, an unplaced connection goes to the active person unless they have that server); the
connect flow places a new sign-in with `placeConnection` (another user on a server the active
person has, or "Add someone" `ADD_SOMEONE_HREF`, is a new person). **Background work keeps ALL
connections** (the offline queue, downloads, address routing, car bookmarks: a switch must never
make another person's saves unroutable); **every list a person SEES is the active profile's**
(`useProfileConnections` / `profileConnections`, never `useSession((s) => s.connections)`; the car
snapshot and the widget follow `activeProfileId`). The rules:
- **`mayActFor(cid)`** is the one play rule, enforced in the playback store at every start
  (`playBook`, `startBookInPlace`, `adoptLoaded`: the player route, the car, a resumed Cast
  session): never another person's book, never while nobody is chosen. Screens only offer the
  switch.
- **Routes carrying `?connection=`** follow `useRouteConnection` (`content-scope.tsx`; `ContentScope`
  for the content screens, called directly by the root routes: player, end credits, year,
  `/connect/ready`): an unknown connection gets a not-found state, another person's gets
  `OtherPersonGate` (switch first, their PIN asked).
- **Nobody chosen** (`mustChoose`: the active person left and others remain; persisted as
  `activeProfileId: null`): the auth gate holds the shell and opens "Who's listening?"
  (`/profiles`, a root full-screen modal); every person-facing list is empty
  (`visibleConnectionIds`), the car lists nothing, the widget clears. A cold launch asks once
  when `askAtLaunch` (turned on when a second person appears).
- **Switching** (`switchProfile`, through `useChooseProfile`): the PIN first when there is one,
  then the other person's playing book is stopped (paused, saved, unloaded) and the default
  connection moves to the new person's first.
- **The PIN's authority is the secure store** (`src/lib/profile-pin.ts`, `audiosilo.profilePin.<id>`:
  a salted, 10,000-round SHA-256 chain, constant-time compare, 5 tries then a 30 s wait). The
  profile's `hasPin` is only a mirror: a hash the mirror lost still asks (and repairs it), and
  setting a PIN over a stored one asks for it first. SHA-256 is pure JS (`src/lib/sha256.ts`:
  no subtle crypto on a plain-http web origin, and an async digest per round was too slow),
  hashed in chunks that let the UI paint. A forgotten PIN: remove that person from the device.
- **A document that can't be read** is retried (`HYDRATE_ATTEMPTS`), never taken as missing
  (rebuilding it would drop every PIN and kids setting). Then: with someone signed in the store
  stays shut (`hydrationFailed`: nothing shows or plays, nobody new signs in) and reads again
  on the foreground; with nobody signed in (web storage blocked) it runs `unread`, in memory,
  for whoever signs in now, never writing the document and never placing a connection it did
  not see signed in.

**Kids mode (Phase 8, `src/components/kids/`, route `/kids`).** A profile's `kids` settings
(library, bedtime). The whole app for that profile is `/kids`: `KidsRouteGuard` (root layout)
sends it back from anywhere but `/kids`, `/profiles` and `/connect` (`kidsAllowsPath`), and sends
a grown-up off `/kids`; the auth gate never mounts the shell for it. The page is ONE `FlashList`
(`KidsStoriesList`: the header, then the shelf as big cover tiles, stories in progress first,
paged as it scrolls; offline, the stories downloaded for that shelf, `kidsOfflineScope`); a story
starts in place with `startBookInPlace` (never the full player), played by `KidsPlayer`. The
Grown-ups button is a 2 s hold that opens "Who's listening?", where PINs apply. The shell's
reconnect banner never shows there (it opens the connect flow): a kid whose sign-in ended sees
`SignedOutNotice` in the page header, a line asking a grown-up (who signs them in again from the
Household page). **Bedtime** is the auto sleep rule while a kids
profile is active (`listenerSettings()` in `src/playback/listener-settings.ts`, which also makes
its default speed 1x: from its bedtime until `KIDS_BEDTIME_UNTIL`, a `KIDS_BEDTIME_MINUTES` timer on
every story; never in the car). **The gate**: `connect/_layout.tsx` is the only gate between the
connect flow and kids mode: while a kids profile listens it runs none of the flow (a link or the
reconnect banner takes the child back to `/kids`, with a toast asking a grown-up), except a
grown-up's "Add someone" on a device with no grown-up (`kidsConnectAllowed`). Nobody new joins
while a kids profile listens and a grown-up is on the device (`mayAddPerson`, in `finishConnect`
and `addMemberHere`), and kids mode is never turned on for the last grown-up (`mayTurnOnKids`; a
device already without one keeps "Add someone" as its way out).

**Listening in the house (Phase 8, capability `household`, `src/components/house/`).** A person
who shares (`HouseSharingRow` on the Household page, `useSetHousehold`) sees what the others on
that server who share are listening to: the Home row (`HouseRow`, after "Next in your series") and
the book page aside's `InTheHouseCard`. `useHouseRows(cid, active)` asks `useHousehold` first and
polls `useHouseListening` (`HOUSE_POLL_MS`, foreground only) only while the caller shares and the
surface is on screen; loading, errors and "not sharing" all read as no rows. The pure rules
(`house-model.ts`) compute the local calendar day by hand (Hermes has no
`Intl.RelativeTimeFormat`). Strings under `house.*`.

**Household members (Phase 8b-1, capability `household_members`, `src/components/household/`).**
An owner adds and manages accounts of their own: a kid (no password or API keys; the owner signs
them in) or a grown-up, each on "Everything I can listen to" or "Only collections I share".
- **Wire**: `useHouseholdMembers` and the member hooks in `hooks.ts`; their mutations reject with
  `CapabilityError` (never to `noteError`). `allowed` (else a `reason`) gates adding only: an owner
  can always rename, sign out and delete their members. `useRevokeMyDevice({ id, alsoMembers })`
  also signs out the members signed in on that device (its `member_sign_ins`; sent only to a
  server with the flag). Switching a member to everything sends `collection_ids: []` (the owner's
  shares to them stop). Removing any connection reads the household again on its server
  (`removeConnection`'s hook in `hooks.ts`).
- **Refusals**: `ApiError.code` with `apiErrorKind(e)` (`client.ts`): branch on the code, fall back
  on the status for an older server, and say it in the app's words; never show `ApiError.message`.
- **Naming the owner**: copy names a member's owner through `managerName(user, { connection,
  people })` / `useManagerName`: the profile holding the owner's own sign-in on this device, else
  `managed_by.display_name`, else the username; never `managed_by.username` directly.
- **Signing a member in here**: `addMemberHere` (a new member, or "They'll also use this phone"),
  `renewMemberHere` (their session here ended) and `signInMemberHere` (`use-sign-in-here.ts`).
  They store the session with `setSession(..., { makeDefault: false })` and give the member a
  profile with `placeConnection(id, { newProfile, keepActive, name })`: the owner stays the
  person listening, so never `switchProfile`. A member's session on this device is marked "This
  device" on their card; signed out from there it takes the dead-token path (`markNeedsReconnect`).
- **Kids**: a kid's account starts in kids mode (`kidsOnForKidAccount`), even with no grown-up on
  the device (the `mayTurnOnKids` exception, `isKidsAccount`). Its shelf is the collections its
  owner shares with it (`kidsShelfMode`; none, or an older server: one library, as before), and
  it plays at 1x by default (`listenerSettings`). The connect gate above keeps the flow out.
- **The Household page**: the phone You hub's Household segment, and `/household` through
  `openHousehold()` elsewhere; `/settings?section=household` redirects there. It holds the people
  on this device, a card per member (access with Change, the Kids switch, their devices, "Set up
  their own device", Rename, Delete twice confirmed, apart from "Remove from this device"), the
  add dialog, then Listening in the house. My devices offers "Also sign out <names>" for a device
  holding member sign-ins, and the collection share sheet notes which members can listen to it.

**The Bridge (Bridge Phase 1a, capability `bridge`, admin only, `src/components/bridge/`).** The
player's first admin-only UI (Bridge decision 9) and its one Bridge kind, `sidecars.generate`
("Generate characters and recaps"); the console covers everything else.
- **Wire** (`types.ts`): `Capabilities.bridge` (a Bridge paired and online) and
  `ServerInfo.bridge {version, features}`; `BridgeJob` (state `queued | claimed | running |
  needs_attention | done | failed | cancelled`; `path` is the book's own `rel_path`; `error` is a
  failure or, while parked, the park message), `BridgeJobList`, `BridgeJobRequest`,
  `SidecarsGenerateParams` (`source` auto/audio/ebook, `contribute` local/issue, `work_id`),
  `SidecarsGenerateProgress` (step, message, done/total, stage, `eta_seconds`, `cost_usd`,
  source, `park {code, hint, retry_at}`), `SidecarsGenerateResult` (with Phase 1c's
  `description` and `description_error?`), `BridgeEstimate` (source, ebook, duration,
  `asr_hours` (0 = not known for audio), `agent_cost_usd` (null = no history),
  `subscription`, `agent_ready`, `can_contribute?`, `figures` (without them readiness and
  costs are only defaults), `writable`, `can_describe?` (Phase 1c; the player queues no
  description), `has {community, local, community_unknown?}` (each `{characters, recaps,
  description?}`), `earlier` (up to 10 earlier series books without recaps, each costed),
  `open_job`: the book's open generate job, else (Phase 1d) the open job of another kind that
  refuses one now, a queued or working `chapters.detect` or (Phase 2b) `sidecars.contribute`;
  its `kind` says which). `client.ts`:
  `bridgeJobs(lib, path)` (`GET /admin/bridge/jobs`, first page), `queueBridgeJob` (201 new, 200
  the open one already queued), `cancelBridgeJob`, `bridgeEstimate` (the upstream budget,
  `UPSTREAM_TIMEOUT_MS`); refusals `library_not_writable`, `kind_unavailable`, (Phase 1d)
  `detect_open` and (Phase 2b) `contribute_open` are `API_ERROR_CODES` (`bridgeRefusalKey`
  words them, its `REFUSAL_KEY` checked against `ApiErrorCode`; never `ApiError.message`; an
  open-job refusal for an earlier book of the series, queued first, reads as the plain
  failure, never as this book's).
- **Hooks** (`hooks.ts`, `qk.bridgeJobs` / `qk.bridgeEstimate`): `useBridgeJobs(lib, path,
  {enabled, active, select})` asks only a server with the flag and only while `enabled` (a
  non-admin would get a 403), `retry: false`; it POLLS (`bridgePollInterval`,
  `src/lib/bridge-jobs.ts`) only while a `sidecars.generate` or (Phase 1d) `chapters.detect`
  job of the book is open and the surface is `active` with the app foregrounded: `BRIDGE_POLL_MS` (10 s) while claimed or
  running, `BRIDGE_IDLE_POLL_MS` (60 s) while queued or parked, never otherwise (the answer
  that sees the job end stops it). When a read first sees the newest job that wrote the book
  `done` (`latestDone`: a generate job, or the console's `sidecars.describe` or
  `chapters.detect`), `refreshAfterFinish` invalidates the book's `/meta` (every variant), its
  item and its chapters (under any path that names them) and WAITS for them before the answer
  lands, once per finish per cache (`finishesActedOn`), so the tabs, `generated` and the
  chapters a Bridge found are in before the status goes and the offer never flashes back.
  Mid-run (Phase 1d: a generate run saves the chapters it found long before its end),
  `refreshMidRun` reads the book's chapters again once per step a running generate job
  reports past chapter detection (`midRunCheckpoint`), only while the cached answer has no
  chapters of its own (at most one, no `chapters_source`).
  `useBridgeEstimate` (`staleTime: 0`, read afresh each time the
  confirmation opens; Phase 2b: polled while its `open_job` is a share holding Generate back,
  `estimatePollInterval`, 10 s while claimed or running, 60 s while queued, so the hold lifts
  once it ends; a detection is not waited for), `useQueueBridgeJob` / `useCancelBridgeJob`
  (`CapabilityError` without the flag; the answer goes into the book's job list, a cancel's 409
  reads it again, a refused queue reads the book's estimate again).
  `useCapabilityQuery` gained `retry`, `select` and a query-aware `refetchInterval` for them.
- **The gate** (`bridge-model.ts`, pure and tested): `mayGenerate(user, server)` = an admin
  (never a household member, a kid's or a demo account, whatever the role says), the `bridge`
  flag, `features` including `sidecars`, AND `metadata` (generated content is served through
  `/meta`). Nothing renders, and no job is asked for, without it. `generateOffer` (Phase 1e,
  one rule with the console's `generate-model.ts`): a dimension is the community's when it is
  present and not `work.generated[dim]` (`communityCoverage`; the server's merge is fill-only).
  The community has both: `covered` (no action; `useGenerate` splits it out as `covered`, and
  the book page's `GenerateCovered` says so, admin-only, with "See characters" opening the
  Characters tab; the companion never shows it). Else
  `regenerate` (the book menu) when some were generated here, else `generate`. Nothing until
  the book's `/meta` answer
  (`metaAnswered`) and its jobs are known, or while a job shows its status (`statusJob`: the
  newest generate job while open or once failed). The player always sends `GENERATE_PARAMS`
  (`source: auto`, `contribute: local`): it never offers to contribute.
- **Surfaces**: `useGenerate` (one book's model: allowed, offer, the confirmation, the queue
  and cancel writes; its own job read is `active: false` with a `select`, so progress polls
  re-render only the status), `GenerateDialog` (the confirmation: source, transcription time
  and agent cost of every run it queues, `runEstimate`, a subscription's note, where the
  results appear, and a switch, on by default, to queue the series' earlier books without
  recaps first, `queueOrder` / `queueInOrder`, stopping at the first refusal; Generate held
  back with `blockedReason` while the library isn't writable, the estimate's `open_job` is a
  `chapters.detect` (Phase 1d: the server would answer 409 `detect_open`) or a
  `sidecars.contribute` (Phase 2b, a console share: 409 `contribute_open`), or the agent is
  KNOWN not ready),
  `GenerateStatus` (polls while its screen is focused: phase, stage words `bridge.stage.*`
  from `stageOf` (Phase 1d adds `chapter_detecting` and the park `chapters_not_detected`;
  a `writing`/`rescanning` step sent with an engine stage before `ready`, the early chapters
  save, reads as that stage),
  counts, ETA, a park's reason `parkReason` and when it resumes, a failure,
  Cancel, or "Try again", re-queueing, once it failed) and `GenerateOffer` (button or status under the companion's empty Who's
  who / Story so far). The book page wires `useGenerate` into `HeroActions` with
  `GenerateStatus` under the actions. Costs format with `formatUsd` (`src/lib/format.ts`).
  Strings under `bridge.*` in all 6 locales; fixtures in `src/testing/bridge-fixtures.ts`.

**Player modules (Bridge Phase 2a, `src/modules/`; NOT the repo-root `modules/`, the native
Expo modules).** A server module (off by default, turned on in the console's Settings >
Modules) brings an optional player feature; its capability flag is its id and reads true only
while it is on AND its Bridge requirement is met (`contributions` is the first,
`Capabilities.contributions`, sent false while off).
- **Player modules registry**: `PLAYER_MODULES` (`registry.ts`) is EMPTY in 2a: the slots
  are open and exercised only by tests, so nothing in the player changes. A `PlayerModule` is
  `{id, homeRails?, youSections?, bookActions?}`. `useActiveModules(list)` keeps the modules
  some server of the person listening has on (`anyCapability` over `useCapabilitiesAll`);
  `useModulesOn(cid, list)` one server's (a book's actions go to its own server).
- **Module flags are mirrored**: a module's `id` is a `ModuleFlag` (`registry.ts`), a flag
  added to `Capabilities` (`types.ts`) like any other and named in `ModuleFlag` too, never a
  core flag such as `queue` (the server refuses a module named after one); the capability
  hooks keep their closed key (a typo in a flag name stays a type error).
- **Slots** take an optional `modules` prop (default the registry; tests pass a fake) and
  read flags through `WithActiveModules` (`active-modules.tsx`), which asks nothing with an
  empty list, so a slot renders exactly as before: Home's `ModuleRails` (after Next in your
  series), the You hub (`youSections` after Account on a phone, after Journal in the wide
  sub-nav; `parseYouSection(raw, moduleKeys)` opens an active module's key, a key of the
  hub's own is ignored, an off module's link opens Stats; a module section is a column the
  hub scrolls; a section's `label` is a function of `t`, so it follows the language) and
  `HeroActions` (`bookActions` after Regenerate in the book menu, keyed `<id>:<key>` so they
  never meet the menu's own keys). A slot returns elements (its hooks live in the components
  it returns; the slots still call `homeRails` and `render` behind a component of their own,
  so a hook reached through one never joins the slot's as the active list changes);
  `bookActions` is a plain function, never a hook. A link (`youHref`, `openYou`) takes the
  hub's own sections only (`CoreYouSection`). `BookTab`, `BookActionKey` and `SettingsSection` stay
  closed until a module needs them (Phase 2d).

**Podcasts (Bridge Phase 2d-1, `src/components/podcasts/`, `src/playback/episode-fetch.ts`).**
The server lists a podcast library (`Library.kind === 'podcasts'`) only to a player of 2.2.0 or
later (`X-AudioSilo-Client`; dev cross-origin needs `EXPO_PUBLIC_IDENTIFY_CROSS_ORIGIN=1`,
`client-id.ts`). An episode is an ordinary item at `/book` with `Book.episode` set (only `GET
/item` sends it; list shapes leave it out, so a framework-free reader tells an episode by its
library: `cachedPodcastLibrary`, `useIsPodcastLibrary`).
- **Reads are core, writes are the module's**: shows, episodes and `/me/podcasts` are never
  gated on a flag; Follow and Unfollow are `useCapabilityMutation('podcasts', ...)` (the module
  on AND its Bridge online), shown only to a listener who may (not a kid's account, not the
  demo); otherwise a followed show is a read-only "Following" badge. The fetch status is
  `podcast_fetch`'s.
- **The fetch has one choke point**: `startBookInPlace` (and the player route's auto-start)
  hand an episode not on its server (`needsEpisodeFetch`: `!episode.downloaded` and
  `podcast_fetch === true`) to `requestEpisodeFetch`, never to `playBook`. The controller probes
  `/stream` once (`prepareEpisodeStream`: `Range: bytes=0-0`, the token in the header), follows
  `GET .../podcasts/fetch` every `max(2, Retry-After)` s (paused in the background, asked at once
  on the way back), and at `ready` reads the item and chapters again and starts it in place with
  `{fetched: true}`. It never POSTs by itself: only Try again does (`retryEpisodeFetch`). Any
  other start (and one that plays the episode itself, on its server by then), a profile switch
  or a removed connection ends it; there is no client time cap. A start overtaken while it
  looked its episode up hands nothing on (`isLatestStart`), and the `fetched` start plays only
  while the fetch is still `starting` (`isEpisodeFetchStarting`: a Cancel or another start wins).
  While it is on its way the full player shows `EpisodeFetchPanel` and the dock / mini player an
  `EpisodeFetchStrip`; the book playing meanwhile plays on (decision 6.4).
- **What episodes never do**: open the end credits (`BookEndedListener` leaves Up next and, with
  auto-play, starts Up next's head only, never the series or folder), cast (`castButtonModel`'s
  `episode`), or download: the downloads store refuses `book.episode` as `unsupported`,
  `DownloadControl` and the tile menu leave it out, auto-download and keep-ahead skip it
  (decision 6.1). Kids mode shows no podcast library (decision 6.2).
- **Surfaces**: the Library's `shows` mode (a podcast library offers Shows and Folders only, a
  book mode's link lands on Shows, its book lists are never asked), the show page
  `/podcast?connection=&library=&show=[&order=]` (the server orders the episodes; a serial show
  defaults to oldest first), the episode page (`EpisodePage`, the book page's branch for an
  episode or any item of a podcast library), and Home's "New episodes" rail (followed shows'
  recent episodes with no progress, after Next in your series). Never "Bridge" in listener
  copy, never the server's English: refusals read through `fetchReasonKey` and the follow errors.
- **Finding shows (Phase 2d-2)**: `/find-shows?connection=&library=[&section=]`
  (`findShowsHref`, `openFindShows`), opened from the Shows mode's Add shows (`ShowsActions`: in
  the sub-nav row on tablet and desktop, above the grid on a phone) and its empty state. Every
  section ends in a follow, so the page is only for a listener who may (`useAddShowsAccess`);
  the sections follow the flags (`availableSections`: `search` needs `podcast_discovery`,
  `import` needs `podcast_opml`, the feed address is always there). The directory searches only
  on submit (never while typing), Apple Podcasts unless the server offers Podcast Index too
  (only then a picker), the device region for Apple only. Artwork loads only through the
  server's proxy with the media token (`discoveryArtworkUrl` refuses any other URL), and a
  failed load mounts again on `artworkRetryDelay`'s schedule. All copy for refusals lives in
  `find-shows-model.ts`; a code it does not know reads as the general line.
- **Follow requests poll only while open and seen**: `useFollowRequests(lib, {active})` reads
  `/me/podcasts` every 5 s only while one of the library's requests is open (`queued`,
  `claimed`, `running`, `needs_attention`), `active` (its screen focused: the Shows mode stays
  mounted under a pushed Find shows) and the app in the foreground. A request ending `done`
  reads its library's show list again (`myPodcastsQuery`).
- **The OPML import is `OpmlWaves`**, a framework-free controller (its own timers, tested with
  fake timers; `useOpmlImport` wraps it at page level so it survives a section switch and ends
  with the page). It re-uploads the same bytes in waves (the server keeps nothing): after the
  last upload's own requests have ended, fewer than five are open and 30 s have passed;
  `Retry-After` on 429 / 503 `opml_busy`; a wave that moves no `limited` row is `stalled`; five
  busy answers in a row stop it; `mayActFor` before each upload; held in the background. A file
  over 1 MiB is refused before any upload.
- **Export my shows** (`useExportShows`, capability `podcast_opml`, works with the module off,
  never the demo) reads `GET /podcasts/opml/export` with the Authorization header (never
  `?token=`), saves it the Journal's way (`saveExport`) and toasts the `X-OPML-*` counts; a
  count the browser cannot read (cross-origin without `Expose-Headers`) reads as unknown, and
  the toast always says private feeds are never exported. Check for new episodes
  (`CheckEpisodesButton`) is for a followed show only, and reads the show again once, 15 s later.

**The book page** (`src/components/book/`, the route `book/[libraryId].tsx` only names
`BookScreen`; rules in `book-page-model.ts` and `book-details-model.ts`, both tested) is the
Stacks book page, laid out by its MEASURED width (`bookPageLayout`: the cover beside the text
from 600, the aside as a right-hand column from 900, between the hero and the tabs below it;
the Up next drawer can leave a desktop page phone-narrow). **Hero** (`book-hero.tsx`):
`CoverWash` from `cover_color` (a neutral wash without one), quiet folder crumbs, the eyebrow
(series + "Book N", opening the series page - every series in `series_list` for a book in
several, apart by " / "; else library and server), the title (one size
smaller past 48 characters), the server's `subtitle` under it unless the title already says it
(`heroSubtitle`), the byline (author and narrator pages; the narrator is plain text
where `browse_people` is off), the facts (`bookFacts`), then the place of a book in progress
(percent, "Chapter N of M", time left at the book's own speed, the progress bar: the page's one
pink thing) or the finished badge (`finished_at`) and the stars (`ratings`, `useBookRating`
keeps the note). **Actions** (`hero-actions.tsx`): the primary (`primaryAction`: Pause while
this book plays, Resume chapter N, Start listening, Listen again; through `usePlayBook` with
`toggle`, so it never restarts the loaded book), `DownloadControl` (`short` on a stacked hero), Up next (Play
next / Add to the end, `queue`), favourite (ink, never pink), Add to collection
(`collections`) and `BookActionsMenu` with `omit` (the items the hero already has), and for an
admin the Bridge's `generate` (below: "Generate characters and recaps" as an outline button
after the others, its own row on a phone; "Regenerate" quieter, in the book menu's `extra`).
Labels that count a chapter by its place ("Resume chapter N" here, on Home and the series page,
"Ch. N of M") go through `contradictedTitle` / `resumeChapterLabel` (`src/lib/chapter-label.ts`):
when the chapter's title carries another number (a book that opens with a Prologue), the label
says the title.
`DownloadProgress` and the transcode note sit under them. Chapter rows, timeline taps and pins
go through `usePlayBook` with `at` (below): a phone opens the player on the place, a tablet or
desktop jumps the loaded book there and plays on, or starts this one there. **Tabs** (`bookTabs()`, `src/components/library/book-tabs.ts`):
Chapters (label Chapters / Parts / Files; the default tab) · Recaps · Characters · Bookmarks ·
History · Notes · Series · **Details**, with counts where already in hand (chapters, bookmarks,
notes, characters met; the counts and the pins read `useBookAnnotations` under the route's path,
the same entries the Bookmarks and Notes tabs write). The active tab's panel is `BookTabPanel`
(`book-tab-panel.tsx`; the tab row is the page's). Chapters (`book-chapters-tab.tsx`) is "The whole book" (the player's
`BookTimeline` for ANY book, pins from `useBookAnnotations`, which `usePlayingPins` reads for
the playing book; the rows' place is `rowAt`, previous/next for a book not playing the player's
own `nextSegmentStart`/`previousSegmentStart`) then the rows (`chapterList`: the real chapters at their corrected starts, a
long chapterless file's 30-minute parts as the player makes them, else the files), ending with a
quiet globe caption ("Chapters from the AudioSilo community database") only when the chapters
answer says `chapters_source: "community"` and the rows are those chapters (not parts or files),
or a server-glyph caption ("Chapters found in the narration on this server") for
`chapters_source: "generated"` (Bridge Phase 1d: a Bridge found them in a chapterless book's
narration; same rule). `knownChaptersSource` (`book-page-model.ts`) reads the answer's open
`chapters_source` (an own-key lookup: a source this build does not know is none, so no
caption); the tab keeps the rule that a caption goes only under real chapters, and one
`SOURCE_CAPTION` table (`satisfies Record<ChaptersSource, ...>`) picks the words and glyph.
Bookmarks and Notes are the shared `AnnotationSection` (below), History is `HistorySection` over the shared
listening sessions. Details (`book-details-tab.tsx`): a `Notice` (`ui/notice.tsx`) saying direct
play / converted for this browser (web, `useNeedsWebTranscode`) / plays from this device, the files table ("about N kbps" = size * 8 / duration, folded past 6),
and the path progress keys on. The **aside** (`book-aside.tsx`): About (`BookAbout`, its words
from the pure `aboutContent` in `book-details-model.ts`: `community_description` with the server's
attribution and "Improve this", else the server's `description`, else the work's core
description, else the description a Bridge generated on this server (`aboutContent`'s `work`, the
`bookMetaWork` value, so an unmatched book has it too, and the one source of every work-level
field, the credit included; `BookAbout` takes it as a required prop; the order is picked once,
into `source`, and a `generated` text wears `GeneratedChip` (`testID` `about-generated-mark`)
under the eyebrow, never the credit or "Improve this"), else a sentence naming the author and
narrator; then the production facts known, the server's own `publisher` / `language` (named via
`Intl.DisplayNames` where the platform has it) /
`abridged` (absent = unknown, no row; the community only ever says true) before the community's; then the book's `genres` and `tags`
as chips (`chipClass`, the filter chips' pill), each opening the Library's Books mode on it in the
book's library, `openLabelBooks`; the publisher rule is `bookPublisher`, shared with the hero's facts),
Other versions
(`BookVersions`), Your listening (`listeningFigures`: started, finished, speed, and the time
listened summed from this book's history spans, `listeningSummary`). The panels render inside the page's own ScrollView (never a nested
vertical scroller). Which tabs exist: chapters when there's a list, the three metadata
tabs only when that data is non-empty (so nothing regresses on an older server; an unmatched
book shows Characters and Recaps only for what a Bridge generated on its server, `bookMetaWork`), bookmarks/history/notes always (they're user-creatable, so they must be reachable from
empty - hence the `emptyLabel`), Details always. `tab` is held as an *intent* (`?tab=`); render
falls back to the first existing tab when data changes under it. Labels come from
`TAB_LABEL_KEY` (same module), which deliberately **reuses** the existing strings
(`library.{bookmarks,history,notes}.title`, `book.meta.characters`).

**Enriched book metadata.** One `useBookMeta` fetch at the screen level feeds
`matchedMeta()` and the placeable blocks exported from
`src/components/library/book-meta.tsx` (and the book page's About card, above):
`BookMetaRecapsTab`, `BookMetaCharactersTab`,
`BookMetaSeriesTab` (the rails' pure rules are `series-rails.ts`). Those take **plain data, not a query**, so a sibling block can be
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
`previousWorks`) are unit-tested. **Community covers** (rail entries, previous-book rows)
never load from their own host on web: a server with `meta_covers` serves them
(`client.communityCoverUrl(lib, path, cover_url, {size})` -> `GET /libraries/{id}/meta/cover`,
`?token=` like every media URL; the server only serves a `cover_url` that book's envelope
hands out, so pass the same `libraryId`/`path` as `useBookMeta`). `BookTabPanel` builds the
resolver with `useCommunityCover(cid, lib, path)` and passes it to the tabs as `coverFor`
(rails and previous rows both at 320, so a cover is fetched and cached once); the rules are `communityCoverSource` (`community-cover.ts`):
proxied when the flag is on, else the direct `cover_url` on native and the placeholder on
web (the player's CSP takes images only from the server), nothing while `/server` is
unknown (an unreachable `/server` counts as no flag). A tab without `coverFor` shows placeholders. Progressive enhancement - **capability-gated** on
server `metadata` (`!!server.capabilities.metadata`, absent on older servers) and nothing renders while
loading/error/`matched:false`. `client.bookMeta` hits `/libraries/{id}/meta`;
`useBookMeta` keys on `qk.bookMeta(cid, lib, path)` (1h `staleTime`, `retry:false` so
a 502 from a down meta service doesn't spin). Strings under `book.meta.*` (plus the
two `book.tabs.*` keys) in all 6 locales. The wire envelope (`BookMeta` discriminated
union in `types.ts`) is hand-mirrored from the server.
**Generated characters and recaps (Bridge Phase 1a).** A book whose `.audiosilo/` holds
characters, recaps or (Phase 1c) a description a Bridge generated on its server carries
`Book.generated: true` (list, search, item, recent and the next book's `book`), and `/meta`
serves them: for an UNMATCHED book
as `{ matched: false, work }` (`work.id`, `authors` and `language` empty, `title` the book's
own), for a matched one in the dimension the community lacks (community content wins per
dimension); `work.generated` (`BookMetaGenerated {characters?, recaps?, description?,
generated_at?}`) says which. **A generated description (Bridge Phase 1c)** rides in its own
additive field, `work.generated_description` (`{ text }`), never in `community_description` (the
shipped 2.0 app shows that one first, as CC BY-SA): the server fills it only when the community
work has no `community_description`, and the player orders it below the book's own description
and the work's core one in About (above). It is spoiler-free by contract, so `spoilers=hide`
keeps it. Every `sidecars.generate` run writes one as it saves (its progress step
`describing`, its result `description` / `description_error?`), the player's Generate
included; the player has no description-only action (the console's "Write a description"
queues `sidecars.describe`, whose finish `latestDone` also counts, so the book's `/meta` is
read again). **The `/meta` gate is ONE predicate, `metaEnabledFor(metadata, book)`
(`meta-gating.ts`)**: the server's `metadata` flag and an ASIN, an ISBN **or `generated`**;
every surface that reads `/meta` goes through it (the book page, the companion and reveal
toast, Home's Now card and Previously on, the end credits, the character search, the offline
copy). Two readers of the envelope, and each field is read through one of them, never both:
`matchedMeta` (the matched half only: the series rails, the AudioSilo Meta links, the end
credits and About's recording facts need a real community match) and `bookMetaWork` (the
matched work or an unmatched book's generated one: About's text and every work-level field,
the Characters and Recaps tabs and their counts, the companion's Who's who and Story so far,
Home's Now card and Previously on, the search's characters). `metaAnswered(enabled, book, meta)` is "the answer is in" for the Generate offer
(a failed lookup is no answer). An unmatched answer WITH a `work` is fresh for only
`META_GENERATED_ONLY_STALE_MS` (2 min, `metaStaleTime`), because the server answers the same
way when the community lookup failed for a book it would otherwise match. Generated content
wears the quiet "Generated on this server" chip (`GeneratedChip`, `bridge.generate.mark`:
`GeneratedMark` puts it at the head of a Characters panel and the Previously On card's list
recap, by `work.generated`'s dimension, a Recaps panel places it per part (`recapMarks`, below),
and the About card under its eyebrow for a generated description) and never the community's
CC BY-SA credit:
**`communityCredit(work, dimension)`** is the work's `attribution` unless that dimension was
generated, and every `Attribution` beside characters (or a lone list recap) reads through it.
A Recaps panel reads
**`recapMarks(generated, shown)`** instead (Bridge 1e): the whole-book summary's source is
`generated.recap_summary` (absent on an older server, whose `recaps` then stands for both),
the list's `generated.recaps` (the wire sets it for either part, but the server takes a generated
summary only with its generated list, so a shown list it flags is generated), so a community
summary beside a generated list keeps its credit and each part wears its own chip when they
differ (one chip heads the panel when every shown part was generated; a part's chip sits under
the list's heading or above the summary).

**Player-redesign data API (Phase 1a, the wire).** `src/api` mirrors the
server's additive redesign endpoints, each gated on its own capability flag (absent on
older servers = false). `useCapability(flag, connectionId?)` reads a flag as `undefined`
(not known yet) / `true` / `false`, and the gated hooks give a server without the flag
no query function at all (`skipToken`), so it is never asked, not even by a manual
`refetch`: `client.authors`/`narrators` (normalised to `PeopleList {people, unknown}`)
and `seriesList` with `useAuthors`/`useNarrators`/`useSeriesList` (`browse_people`), and
`client.listBooks` with `useLibraryBooks` (a `narrator` filter waits for
`browse_people`; a `series` filter waits for `/server`, then asks with `memberships=1` on
`series_memberships`, as `useSeriesList` does: a book in several series, `Book.series_list`,
is matched and counted in each; with the `batch` option (series cards only) on `series_books`
a plain series list (`isPlainSeriesQuery`: `series` with `memberships`, no other key) fetches its
first page through `client.seriesBooksPage`, a per-(library, page size) `createBatchLoader`
(`src/lib/batch-loader.ts`) that collects every series asked for within 10 ms into one
`GET /libraries/{id}/series/books?name=...` per 50 names (fewer when long names would pass 4000 query bytes), under the same `qk.libraryBooks` key,
later pages staying on `/books`; that branch never reads react-query's `signal`, so a card
scrolled off still caches its page from the shared request, which nobody cancels, until a
later page of that query has read it: react-query then cancels the refetch, keeping the old
pages); `client.nextBook` + `useNextBook` (`next_book`, server-resolved: community when it
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
content), rail entries `local`, the recording `chapter_count`. Phase 2's browse screens
(below) consume the browse lists, `next_book`, the thumbnails and the cover colours; the book
screen and the player still gate spoilers and pick the next book on the device.

**Player-redesign user state (Phase 1b, the wire; Phase 2 uses `queue`, `collections`,
`progress_edit` and `user_stats`).** Same pattern, six more
flags: `queue` (`useQueue` + set/add/remove), `collections` (`useCollections`,
`useCollection(id)`, `useShareTargets(enabled)` - pass false for demo accounts, which
get a 403 - and the collection/items/shares mutations; read-only sharing, a viewer's
`shared_with` is absent), `ratings` (`useRating`, `useMyRatings`, set/delete; a PUT
replaces the whole rating, so an omitted `note` clears it; PUT resolves a part path to
its book but GET/DELETE are exact, so key rating UI on the book's path; list adds resolve
too and list removes are exact, so remove with the entry's own path), `progress_edit`
(`useEditProgress`: PATCH dates / mark unfinished; it does NOT touch the local progress
mirror or offline queue, decision 7; to mark unfinished a book finished at its end, send
a `position` too, or the player resumes it at the end and it finishes again), `user_stats`
(`useMyStats(range)`, `useMyListening(range)`, `useListeningGoal` + set/clear; server
time) and `my_devices` (`useMyDevices`, `useRevokeMyDevice`: NOT for the `current: true`
row - revoking it kills the token before `teardownBeforeTokenRevoke` can save the final
position and the queued progress, so that row signs out through `useSignOut`). A
whole-list PUT (`useSetQueue`, `useSetCollectionItems`) deletes the caller's hidden
(out-of-access) rows too; move one book with an add and a `position` (an index in the
visible order) instead. **Mutations check their flag at call time** and reject with
`CapabilityError` without sending anything when the flag is false or `/server` hasn't
answered yet (no request, so no 401 and no reconnect flag; never hand it to `noteError`,
which reads any non-`ApiError` as an unreachable server). Each mutation stores its answer
through `storeAnswer` (cancels a read of the same key in flight, which would land over
it, and reads again), is keyed by connection (`mutationKey`, so a pending write keeps
its own connection) and runs one at a time per capability and connection (`scope`).
Gating tests live in `hooks-capability.test.tsx`; each was checked to fail with its gate
removed.

**Player-redesign annotations (Phase 4, the wire).** One more flag, `annotations`: bookmark
labels, edits, and the across-books lists. A bookmark's `label` is a machine key, never display
text (`''` for none; the player's keys and `isBookmarkLabel` are `src/api/bookmark-labels.ts`:
the five `PICKABLE_BOOKMARK_LABELS` and `FELL_ASLEEP_LABEL`; a newer client may store others,
so name a label only once the guard knows it). `client.updateBookmark` / `updateNote` PATCH
(`BookmarkPatch {note?, label?}`, `''` clears the label; `NotePatch {body?, position?}`) and send
only the patch's own fields; `myBookmarks` / `myNotes` / `allHistory` return one `Page {items,
next_cursor?}` (`allHistory` works on every server: an older one ignores the cursor and answers
one page without each row's `book`). The across-books lists are infinite-query option factories
in `hooks.ts`, `myHistoryQuery` / `myBookmarksQuery` / `myNotesQuery` (one `PAGE_SIZE` and stale
time; the two gated ones take `supported` and get `skipToken` without it), read with
`keepFirstPage` on release so a list read 20 pages deep doesn't refetch all 20 next time.
`useUpdateBookmark` / `useUpdateNote` are capability mutations (`CapabilityError`, nothing sent,
as above). **`label` is sent ONLY to a server known to have `annotations`**, because the server's
decoder refuses unknown fields (a 400, and the bookmark is lost): the one owner of that gate is
`postBookmark` in `hooks.ts` (`useAddBookmark` on `useCapability`, the framework-free
`addBookmark` on `cachedCapability`; not known yet counts as no, and the bookmark is still made
without its label). Never call `client.addBookmark` with a label directly. The server answers
fixed-width UTC timestamps with milliseconds (so they compare as strings) and `[]` for an empty
per-book list (the client still reads an older server's `null` as none).

**Spoiler gating by listening progress** (`src/components/library/meta-gating.ts`,
all pure + tested). The listener's position is a 1-based chapter NUMBER derived
from **ONE whole-book POSITION** (`useBookPlace`'s `listening`, also Search's and the series
page's) - the player's live position when this book is loaded (never below the saved one;
and only once its engine load has landed, `selectPlacedBookKey`: until then the snapshot is
still the PREVIOUS book's place, the store's `loadingBook`),
else `useBookProgress` (`qk.progress(cid, lib, path)`) - walked through `chapterNumberAt` against the
screen's *corrected*, memoized chapter offsets (`chapterStarts`, recomputed from the
cumulative file durations, not the server's `book_offset`); no position → 0. **Never
the player's chapter identity**: a chapterless single-file book gets *synthetic*
30-minute chapters (`synthesizeChapters`) whose indexes are wall-clock slices, so
reading them as logical chapter numbers revealed the whole cast an hour in. The
consequence is that a chapterless book gates to 0 whether playing or not (accepted -
"Show anyway" is the escape hatch). The live position is sampled in coarse buckets
(`LIVE_POSITION_BUCKET_S`, exported by `meta-gating.ts` for the book page and Search's
characters; Previously on reads the saved place, never the live one) so the screen re-renders at chapter-ish granularity
rather than per tick; rounding DOWN can only delay a reveal, never reveal early. The player's
companion needs no bucket: `useListeningChapter` selects the chapter NUMBER on the exact live
place (`selectLivePosition`), so it re-renders only when the chapter changes and turns over at
the boundary itself.
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
  audio, lock-screen/remote commands, gapless multi-file playback, pitch-corrected
  speed, the audio effects and the car). `service.ts` is a throwing fallback for tsc only.
  (There is **no** `register.native.ts` and no react-native-track-player - both are gone; the
  native module registers its own background service.)
- **The module's surface** (`modules/audiosilo-player/src/AudiosiloPlayer.types.ts` +
  `AudiosiloPlayerModule.ts`): the transport, `load(tracks, startIndex, position, chapters?,
  book?)` (the chapter clips drive both lock screens; `book`, a `BookRef`, names the queue so an
  engine that outlives the JS can say later which book it holds), `setConfig` (auto-rewind, skip
  lengths, `smartSpeed`, `voiceBoost`), `setCarSnapshot(json)`, `getLoadedBook()` (Android; iOS
  null) and `consumePendingBookmarks()` (Android; iOS `[]`); events `onRemoteMove`,
  `onRateChange`, `onRemoteBookmark`, `onCarConnection`, `onCarPlayRequest` and
  `onProgress.silenceSaved`. **Feature-detect every function added after the first shipped
  builds**: the JS bundle can be newer than the installed binary (a store build lags), and an
  Expo function called with more arguments than it declares throws. So `load`'s 5th `book` is
  passed only when the binary also has `getLoadedBook` (`moduleTakesBook` in
  `service.native.ts`; the two ship together), the way `setVolume` is detected, and the car seam
  (`src/car/car-native*.ts`) answers null / `[]` and never fires on an older binary. Events need
  no detection (an older binary never sends them).
- **Remote moves vs the resume floor.** The `resumeFloor` save guard (below) lowers only for a
  deliberate move, and the lock screen, a headset, CarPlay and Android Auto (their chapter lists
  too) move the engine without the JS asking. The module reports those as `onRemoteMove
  {trackIndex, position}`, in file coordinates, **once the move has landed**;
  `service.native.ts` updates its snapshot first (so a save inside the handler saves the landed
  place), and the store's handler (`userMoved`) lowers the floor to it, counts it in
  `localMoves` (a place reconcile in flight stands back) and persists. Without it a lock-screen
  scrub back past the 60 s tolerance never saved. Never sent for JS-asked moves (`seekTo`,
  `skipToTrack`, `load`), auto-rewind, Smart speed's skips or a file running on into the next.
  `onRateChange` (iOS's rate command, CarPlay's rate button, an Android controller; already
  applied) sets `rate` (clamped; only an out-of-range speed goes back to the engine) and
  persists. The web has neither: its Media Session seeks go through the store (`onRemoteSeek`)
  before the element moves.
- **The iOS engine is split into files** (`modules/audiosilo-player/ios/`, read their comments
  before touching them): `AudiosiloPlayerModule.swift` is only the Expo module definition;
  `AudioEngine.swift` is the engine (one per module, `AudioEngine.shared` for CarPlay);
  `ChapterClips.swift` the pure chapter-clip maths; `VoiceBoostTap.swift` + `VoiceBoostDSP.swift`
  Voice boost; `AudioEngine+CarPlay.swift` what the CarPlay templates read (the loaded book from
  `load`'s `book`, the chapters, the rate); the scene and CarPlay files are under Car below. A
  native change needs a full rebuild; only `ChapterClips` and `VoiceBoostDSP` have a host check
  (Tests below). Known iOS gotchas handled in `AudioEngine.swift`:
  - **Seek before ready.** Seeking a freshly-created `AVPlayerItem` before it reaches
    `.readyToPlay` is silently dropped (esp. streaming) - this made resume start from
    0. The resume/skip start position is **deferred** until `.readyToPlay`
    (`pendingSeek`/`applyPendingSeek`), with play gated (`wantsPlay`) so audio never
    briefly starts at 0. Android doesn't have this - Media3's `setMediaItems(items,
    startIndex, startPositionMs)` honors the start natively.
  - **Single earbud press / "pause needs two presses".** A device ignores
    `MPNowPlayingInfoCenter.playbackState` for third-party apps, so iOS infers our play state
    itself and can get stuck (sending Play while we're already playing, so the press no-ops).
    Fix: route the play, pause AND toggle remote commands all through one
    real-transport-state `togglePlayback()` (reads `player.timeControlStatus`), so a single
    press always flips playback. The engine still sets `playbackState` (`syncPlaybackState`,
    on every `timeControlStatus` change, whole-info rewrite and `reset`) because the
    **Simulator** honours it: without it CarPlay's Simulator window reads the app as paused. It
    is not the earbud fix; don't lean on it on a device.
  - **Interruption auto-resume.** Only resume on interruption `.ended` if we were
    actually playing when it began (`wasPlayingBeforeInterruption`) - otherwise the
    charging chime (a brief interruption) resumes a paused book.
  - **Chapter Now Playing (parity with Android).** `load` keeps the chapter clips (the same
    clips Android plays as items; one naming a file outside the tracks drops back to file
    mode, as `buildChapterClips` does). With 2+ clips Now Playing shows the chapter: its title,
    the book as album, a chapter-relative duration and elapsed, chapter number and count. The
    1 s tick updates only elapsed and rate unless the playhead crossed into another clip. The
    scrubber's time is chapter-relative (clamped into the shown clip); next track = the next
    clip (across files through `skip(to:position:)`), previous restarts the clip past 3 s
    (`ChapterClips.restartThreshold`, Media3's rule), else the previous one. 0 or 1 clips:
    whole-file info and next/previous file. Which of the skip or track buttons the lock screen
    draws is iOS's choice; headsets and CarPlay send the track commands.
    `changePlaybackRateCommand` lists `supportedPlaybackRates` 0.75-2 (CarPlay's rate button
    needs it), and Now Playing always carries `DefaultPlaybackRate`, so CarPlay doesn't read 0x
    while paused.
- **Android: a `MediaLibraryService` with chapter controls (Audible parity)**
  (`AudiosiloPlayerService.kt` + `AudiosiloPlayerModule.kt` and helpers). The service is a
  Media3 `MediaLibraryService` (Android Auto browses it too, Car below) whose session player is
  `AudiobookPlayer`; the module drives it through a `MediaController`. Each **chapter is a
  clipped `MediaItem`** (`MediaItem.ClippingConfiguration`, built from the `chapters` arg to
  `load`), so the system scrubber is **chapter-relative** and `COMMAND_SEEK_TO_*_MEDIA_ITEM`
  give **prev/next chapter**. The **skip buttons** seek by the listener's skip lengths
  (`PlayerConfig`) and wear the nearest of Media3's **predefined** `CommandButton` icons
  (`ICON_SKIP_BACK_5/10/15/30`, `ICON_SKIP_FORWARD_*`, since Media3 **1.5.0** - no app-shipped
  drawable, not icon-less, so the old "Android 16 drops icon-less actions" problem is gone),
  wired as **custom session commands** (`setSessionCommand` +
  `MediaSession.Callback.onCustomCommand` → `player.seekBack()/seekForward()`), **NOT**
  `COMMAND_SEEK_BACK/FORWARD` - those map to the legacy `ACTION_REWIND`/`FAST_FORWARD` that
  the modern Android media UI silently ignores (`dumpsys media_session` showed
  `custom actions=[]` and no buttons). **Register them with `setCustomLayout`, NOT
  `setMediaButtonPreferences`**: the slot-based preferences API caps the 1.5.1 notification
  at 3 actions (drops the secondary slots - `dumpsys notification` showed `actions=3`),
  whereas `setCustomLayout` makes the provider emit standard `[prev, play, next]` (auto, when
  the seek-to-prev/next commands are available) **+** the custom skip buttons = all 5
  actions, alongside the draggable chapter scrubber → the full lock-screen row
  `[prev-ch] [scrubber] [next-ch] [back] [fwd]` (`dumpsys`: `actions=5`, device-verified on a
  Pixel). A third custom button, the bookmark (`audiosilo.BOOKMARK`), is left out of the
  notification's own actions by our `NotificationProvider` (so the phone keeps its five) and
  shows in Android Auto's overflow. The **app logo** is the notification small icon
  (`DefaultMediaNotificationProvider.setSmallIcon` +
  `android/.../res/drawable/ic_notification.xml`). `AudiobookPlayer` (a `ForwardingPlayer`)
  still applies auto-rewind on every `play()` and hides prev/next **only when there's a
  single item** (a chapterless single-file book, so "previous" can't restart it).
  - **The JS store + iOS stay file-based**: the Android module translates between its chapter
    clips and the file-relative `(trackIndex, position)` the bridge reports through
    `TimelineMap` (in `MediaItems.kt`: `fileToItem`/`itemToFile`), built from each item's own
    `MediaMetadata.extras` (`fileIndex`, `startInFile`, the file's duration, plus the
    `BookRef`), so it is right for a queue the module loaded AND for one the service loaded
    itself (the car). Items are built by one `MediaItems.buildQueue` / `toClipItem`.
    `buildChapterClips` (`book-queue.ts`) returns `[]` for 0/1 chapters → one item per file. A
    `SimpleCache`/`CacheDataSource` keeps clipped single-file **streaming** gapless (clips
    re-open the same URL) - device-verified on a Pixel; the safety fallback if a future device
    regresses is to make `buildChapterClips` return `[]` for single-file books.
  - **Who moved the player.** The module's controller connects with the hint
    `audiosilo.app=true`; `PlayerBridge.isAppController` requires the hint **and**
    `controller.uid == Process.myUid()` (any app can send the hint; Media3's own notification
    controller shares the uid but not the hint). `AudiobookPlayer` reports a seek, skip or
    speed change from any other controller (`isRemoteRequest`; the custom skip commands, which
    the session doesn't attribute, pass their origin through `withOrigin`). The service's own
    moves (auto-rewind, a car play spec's rate) run inside `internal { }` and never count: **a
    new service-made seek or speed change must go through `internal { }`**, or JS reads it as
    the listener's and lowers the resume floor. The module emits `onRateChange` at once and
    `onRemoteMove` once its own controller has caught up (its next position discontinuity, or
    300 ms).
  - **The exported service is a security boundary.** Auto and the system bind to it, and
    Media3's default would accept any item carrying a URI and fetch it with the session's auth
    header. So `onAddMediaItems` refuses every controller but the app's, `onSetMediaItems` from
    another controller takes only car item ids and voice queries, and `AuthHolder` adds the
    bearer token **only to requests to the origin of the loaded book's tracks** (never to
    another host an item or artwork URI names). Keep all three when touching the service.
  - **`PlayerConfig` persists** (auto-rewind and the skip lengths, in the `audiosilo.player`
    SharedPreferences, beside the effects switches) whenever `setConfig` changes it, and the
    service restores it in `onCreate`, so a book the car starts with no JS honours the
    listener's Settings.
- **Smart speed and Voice boost** (two device-wide settings, `smartSpeed` / `voiceBoost` in
  `src/stores/settings.ts`, off by default, reaching the engine through `configure`; the pure
  platform rules in `src/playback/effects.ts`; ONE `EffectsSettings` component in both the
  speed sheet and Settings > Playback; no wire change). **Voice boost** runs everywhere it can,
  with one native preset (80 Hz high-pass, -20 dBFS, 3:1, 6 dB soft knee, +12 dB make-up,
  -1 dBFS limiter: the per-sample peak detector puts the unity point at -2 dBFS, above
  narration's peaks, so the make-up is never taken back): Android a `VoiceBoostProcessor` after
  Sonic (always active; the switch ramps dry/wet over ~20 ms, since toggling `isActive` would
  flush the sink: a gap and a position jump); iOS an `MTAudioProcessingTap` per item running
  `VoiceBoostDSP` (no allocation, locks or Swift refcounting on the render thread; every item
  gets its tap before it plays, switch on or off, for the current item and two ahead, because
  setting `audioMix` on a playing item is a ~1 s dropout); the web a Web Audio
  compressor/trim/limiter, never in WebKit-only browsers (choppy, ignores `playbackRate`,
  suspends when locked) and for same-origin sources only (a cross-origin element routed through
  Web Audio plays zeroes). **Smart speed is Android only**: `NarrationSilenceProcessor` (a
  vendored port of Media3 1.11.1's silence skipper; 1.5.1's keeps a quarter of the padding)
  heads `AudiosiloAudioChain` (silence → Sonic → boost, so skipped frames are book time and the
  boost's attack and release are real time). The switches reach the service as
  `audiosilo.SET_EFFECTS` and persist in SharedPreferences, so a service started without JS
  applies them. **Not on iOS** (withdrawn after a device test): a tap can't drop frames, and
  changing AVPlayer's rate while it plays is an audible dropout, so it stuttered at every
  pause; a real version needs an `AVAudioEngine` path for downloaded books. iOS ignores
  `config.smartSpeed` and sends no `silenceSaved`, and the switch says why. **Time saved**
  (`src/playback/time-saved.ts`): `silenceSaved` is Android's process-wide, monotonic total;
  `silenceDelta` counts only its growth (the first total this JS sees is a base, since the
  service can outlive the JS), per book (`contentKey`) and lifetime, in
  `persistedDocument('audiosilo.timeSaved')`, flushed on a halt, on leaving the foreground and
  every 30 s (an `engineTicker`), purged per connection; read through `useTimeSaved` /
  `useBookTimeSaved`.
- **The download hot-swap plays on from intent, not from `playing`** (`switchCurrentBookToLocal`:
  `wasPlaying` is `playing` or `wantsPlayback`). A short book's automatic download
  (`autoDownloadNext`, default `'wifi'`) can land while its start is still `loading`, or just
  after the engine began playing but before its `playing` reached JS; iOS's `load` pauses the
  player (Android keeps `playWhenReady`), so a swap that didn't play left a kid's first story
  stopped on Play, or on a watchdog error (8b-1).
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
  by `bootstrapPlayback` before the stores hydrate). The Phase 8 identity migration moves the
  native folders to the new ids; the web keeps them under the legacy id (`legacyIdOf`).
  `onConnectionRemoved` deletes a removed server's downloaded files. **Each surface lists only
  the person listening's downloads** through `visibleDownloads(entries, ids)`
  (`src/downloads/downloads-view.ts`: the Downloads page, the car's Downloads tab, kids mode's
  offline stories); the device keeps everyone's, and they keep playing for their owner.
  Downloads no connection in the session holds (a connection that left without its purge) are
  `orphanDownloads`: the Downloads page lists them under "Not signed in", to remove only.
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
- **Never navigate while the app is in the background.** `/player` and `/finished` are
  root `fullScreenModal`s and iOS cannot present one from the background (a book that
  ended locked with auto-play on came back to a black screen until a relaunch). Code
  that playback drives (`BookEndedListener`, the end-credits Play now and countdown)
  moves on with `advanceTo` (`src/components/player/end-of-book.ts`: start the next book
  in place with `startBookInPlace`, item + chapters through the query cache then
  `playBook`, and take it off Up next with `dropFromQueue`; the finished book leaves Up next
  where it is finished, whether or not the next one starts) and
  defers any screen with `whenActive` / `navigateWhenActive` (`src/lib/when-active.ts`).
  The `/player` route only shows a book started that way; it never starts it. A book that ends
  while a sleep timer runs for it does not move on by itself (`useAutoPlayHold` in
  `end-of-book.ts`): the background start in place is skipped and the credits hold their
  countdown (Play now still plays), since the listener asked the timer to end the night. The
  framework-free reads this flow (and the play path's capability read) wait on go through
  `fetchFailFast` (`api/hooks.ts`), which TanStack can't hold for the browser's online flag or
  a hidden tab's focus; the credits' countdown counts only the time its ticks saw, so a
  suspended app doesn't wake to a countdown that already ran out.
- Progress: `progress-sync.ts` saves last-write-wins (`version: 0` + `updated_at`,
  server reconciles) with an offline replay queue; `store.ts` saves every 15s while
  playing and on pause/seek/rate/stop/ended. Android pauses every JS timer with the screen
  off, so the periodic work that must run while a book plays there (the 15 s save, the sleep
  timer's countdown and fade, auto sleep's poll) is an `engineTicker` (`engine-ticks.ts`):
  its interval OR the engine's own events (the store calls `engineTick` on every snapshot),
  whichever comes first, at most once per period. A new periodic job that must survive the
  screen being off uses it rather than a bare `setInterval`/`ticker`.
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
- **A loaded book picks up another device's place** (`src/playback/place-reconcile.ts`,
  started from the root layout). When the app comes back to the front, the book's server comes
  back, or the book plays again after `LONG_PAUSE_MS` (60 s) of pause from any source (the
  store's `onPickedUpAgain`, called before that play's first save), the loaded book asks its
  server for its progress, and meanwhile the store holds its saves (`holdSaves`: 5 s at most,
  then it saves the held place). It moves only when the record is from another `device_id`,
  newer than this device's mirror (a newer unsynced save here wins), not finished, and more than
  30 s away, and stands back if the listener moved meanwhile (`localMoveCount`). The move goes
  through `seekBook` and a toast offers Undo. This module is the only place that reconciles a
  loaded book: never call `toggle()` expecting it to look anything up.
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
- **A browser autoplay refusal is a pause, not an error.** A cold `/player` deep link has
  no user gesture, so `audio.play()` rejects with `NotAllowedError`. `service.web.ts`
  reports exactly that as `AutoplayBlockedError` (`types.ts`) with its snapshot `paused`;
  `startEngine` in `store.ts` (the play step of `playBook`/`toggle`/`retry`) catches only
  that, clears the intent (so the watchdog can't synthesize `error`) and settles on
  `paused`. Every other `play()` failure still propagates.
- **The web engine's file advance is not a pause.** The element fires `pause` just before
  `ended` at a file's natural end; when another file follows, `service.web.ts` ignores it
  (the store keeps its intent through the next file's load, under the same 3 s watchdog as
  a transcoded seek), so a chapter sleep timer aimed at that boundary finds the book live and
  pauses it. A load plays on `loadedmetadata` only if `pendingAutoplay` is still set (a
  `pause()` inside the load, the listener's or the sleep timer's, clears it and settles the
  snapshot on `paused`). A transcoded stream is never requested inside its last second
  (`transcodeStartAt`): at the very end there is nothing to encode and the element errors
  instead of ending.

**Car (CarPlay and Android Auto)** (`src/car/`, the native side in `modules/audiosilo-player`;
the full write-up is the docs' `docs-developers/frontend/native-integrations.md`). No wire change.
- **JS decides what the car lists.** Native has no strings, no session and no server, so
  `car-model.ts` (pure, `buildCarSnapshot`) builds ONE JSON snapshot and hands it over with
  `setCarSnapshot`; native keeps the last one on disk, so a car shows its lists at once, before
  or without JS. It holds the localized labels and up to four tabs: Continue listening (Home's
  rule, the loaded book first), Up next (the queue the app shows, `queueConnectionId`; left out
  when that server lacks `queue`), Downloads, and the Library tab's library. An item's id is
  `carItemId` (`book:` + the URI-encoded connection id, library id and path: never a DB id),
  and it carries its `BookRef` so native compares fields instead of decoding the id. Covers are
  files the app wrote (`car-artwork.ts`), never URLs. **Play specs are Android only**: a
  downloaded book's item carries `file://` tracks with NO headers, its chapter clips, its start
  (`resumeStart`) and rate, so the service can start it with no JS; no session token ever
  leaves expo-secure-store for the car.
- **`car-controller.ts`** (`startCarSync`, from the root layout and the car task; a no-op on the
  web and on a binary without the car functions) **builds nothing until a car has connected on
  this device** (`audiosilo.carSeen`), so a phone that never meets a car never builds a
  snapshot or fetches car covers. Then: at start, on a car connect, a language change, a book
  starting or pausing in the car, and 2 s after the lists, queue, downloads, connections,
  library selection or default speed change; never two writes within 2 s. It never overwrites
  native's snapshot with a worse one (not while `sessionHydrateFailed()`, not with unreadable
  lists once one was written). Every write, play request, adoption and bookmark drain waits for
  `bootstrapPlayback()`. It answers `onCarPlayRequest` (`handleCarPlayRequest`: the loaded book
  plays on, never restarted; any other starts through `startBookInPlace` from its saved place,
  a downloaded one from its download; **while casting it ends the cast first**, `endCastForCar`:
  the receiver's place comes home, then the book plays in the car, never on a TV the driver
  can't hear) and **bookmarks**: `carNative.onBookmark` (the module's
  `onRemoteBookmark`, carrying the engine's own book) adds one through the framework-free
  `addBookmark` (no label, so the `annotations` gate has nothing to hold back) at the engine's
  place on the book the engine names, else the loaded one; Android's bookmarks pressed with no
  JS (`consumePendingBookmarks`) drain at start and on every foreground, and one that can't
  reach its server waits under `audiosilo.carBookmarks`.
- **`src/playback/book-source.ts`** is the one rule for how a book starts: `bookSourceOf` (the
  item, chapters and local files: the download's copy, else through the query cache),
  `resumeStart` (a finished book starts at 0) and `localFromManifest`. `playBook`,
  `startBookInPlace`, `adoptLoaded` and the car's play specs share it, so the car and the
  phone start a book at the same place.
- **Auto sleep stays off in the car**: `car-connection.ts` (`isCarConnected`, written by the
  car sync and, on iOS, by the car start in `register-car-task.ios.ts`) is read by
  `auto-sleep-controller.ts`, so the nightly timer never pauses a driver. It is its own module
  so no reader imports the car sync.
- **Android Auto.** `LibraryCallback` + `CarBrowseTree` answer browsing from the snapshot;
  `ArtworkProvider` serves only covers the current snapshot names inside the app's data
  directory. `playFromCar`: the book already loaded plays on; a downloaded book starts from its
  spec **only when no JS runtime exists** (with JS running, JS may hold another book as
  `nowPlaying`, and swapping the engine under it would save one book's place as another's);
  anything else emits `onCarPlayRequest` and completes with the module's next `load` (10 s, then
  `labels.unavailable`). Voice ("play X on AudioSilo") goes through `playFromSearch`; there is
  no search button. `ResumptionReceiver` refuses to start the foreground service when nothing
  is resumable (one that doesn't start playback within seconds crashes the app,
  `ForegroundServiceDidNotStartInTimeException`); `CarConnectionMonitor` reads the Auto host's
  connection provider (Media3 only notices a legacy controller leaving by timeout).
  - **Headless JS.** When the service needs JS (a car play, a book playing with no JS that
    must save, a pending bookmark, Auto connecting), `JsRuntime.ensure` starts the app's
    `ReactHost` in-process (not a `HeadlessJsTaskService`: Android 12+ forbids starting a
    service from the background, and we already run inside one) and then the headless task
    `AudiosiloCar`, even in an already running runtime (React Native fires JS timers with no
    activity resumed only while a task runs, and the snapshot writes are timers). `index.ts`
    (`package.json` `main`) imports `src/car/register-car-task` (empty on the web; iOS: see CarPlay below)
    **before** `expo-router/entry`. `runCarTask` (`car-task.ts`) runs `bootstrapPlayback()`,
    starts address routing, the place reconcile and the car sync, and resolves once no car is
    connected and the player has been idle `CAR_TASK_IDLE_MS` (30 s).
  - **Adopting.** `getLoadedBook()` names a book the service loaded without JS (the car
    started it, or it kept playing while JS restarted). The controller calls the store's
    `adoptLoaded(book)` (at start, on a car connect, on the foreground, and when the engine
    moves file or starts playing on its own), which builds the queue from `bookSourceOf`, sets
    `nowPlaying` and the rate, makes the resume floor the engine's place, seeds the bridge
    (`adoptPlace`, so the next tick maps onto the right file) and, if playing, runs the
    pick-up check before its first save, all **without `svc.load`** (a reload would cut the
    audio). Regression tests: `store-adopt.test.ts`.
- **CarPlay and the UIScene life cycle** (`plugins/withCarPlay.js`, tested over an SDK 56
  AppDelegate fixture by `withCarPlay.test.ts`). Declaring any scene moves the whole iOS app
  onto the UIScene life cycle (the iOS 27 SDK will require it anyway), where UIKit never shows
  a window the app delegate made. So the plugin writes a phone scene and a CarPlay scene into
  the manifest, and rewrites the AppDelegate so the template's window creation +
  `startReactNative` become a stored starter (`AudiosiloScenes.configure`) that the first scene
  to connect runs (a CarPlay-first launch, maybe with the phone locked, into an off-screen
  parking window the phone scene adopts later). **The template text is matched exactly and any
  other text fails the prebuild** (a silent miss would ship a black screen), so an Expo SDK bump
  updates the plugin and its fixture. **Plugin order**: mods of one kind run in REVERSE
  registration order, so **no plugin that rewrites the AppDelegate may be listed after
  `withCarPlay` in `app.json`** (its edit would run first and break the match). The
  `com.apple.developer.carplay-audio` entitlement is added **by default** (Apple granted it
  2026-10-09; app.audiosilo and app.audiosilo.dev carry the capability); `AUDIOSILO_CARPLAY=0`
  at prebuild leaves it out for a signing identity without the grant, and without it iOS never
  connects the CarPlay scene (the scene code still ships). The phone scene
  delegate rebuilds launch options from `connectionOptions` and re-feeds URLs and user
  activities to the app delegate: **pairing deep links, cold and warm, are the regression to
  check** after any change here. The templates (`AudiosiloCarPlaySceneDelegate.swift`): a tab
  bar of lists from the snapshot; a tap always asks JS (`onCarPlayRequest`: JS has the session,
  the saved place and the queue rules) and pushes Now Playing once the engine reports the book
  (gives up after 10 s); Now Playing reads the engine's chapter info and adds a chapter list, a
  rate button and a bookmark button. Car events wait in `AudiosiloCarEvents` until JS listens.
  - **A CarPlay-first launch never renders the React tree.** React Native runs in the
    parking window, which never gets a layout pass, and expo-router's `ExpoRoot` wraps the app
    in a `SafeAreaProvider` with no initial metrics on native, which renders nothing until the
    native provider reports insets (it needs a layout pass). The bundle and its timers run,
    but the root layout and everything it starts don't, until the phone app opens. So **iOS
    starts the car's work without the tree, like Android's headless task**:
    `register-car-task.ios.ts` (imported first from `index.ts`) listens for the car connection
    and on a connect runs `startCarWork` (`car-task.ts`), which runs `startCarStack` (the
    same start as Android's `runCarTask`: `bootstrapPlayback`, the address pick, the place
    reconcile and the car sync) once per runtime (the root layout's later starts are shared
    ones). Its listener is the first, so it alone gets the connect native queued before JS
    listened; it records it with `setCarConnected` (`car-connection.ts`), and the car sync,
    starting while `isCarConnected()` is true, runs its connect path once itself (the sync's
    own listener registers later and never sees that connect). Play requests and bookmarks are
    the sync's listeners, so a tap queued natively is answered as soon as the sync runs. With
    no `ApiProvider` mounted the reachability probe builds its client from the session
    (`resolveClient`), so a server that dropped out mid-drive comes back (and its queued saves
    flush). **Anything new a car needs must be started from `startCarStack`, never only from a
    screen or the root layout.**
  - **Covers survive a container move.** The snapshot names covers by absolute `file://` path
    and iOS moves the data container on an update or restore; when a cover can't be read
    where the snapshot names it, `CarArtworkPath` reads the same `Documents/`/`Library/` path in
    the current container (never outside it). Covered by `modules/audiosilo-player/ios/SelfCheck/run.sh`.
- **Tokens on a locked phone** (`src/lib/secure-store.ts`). CarPlay starts books with the phone
  in a pocket, and the default `WHEN_UNLOCKED` keychain item can't be read then. On iOS tokens
  live in their own keychain service, `audiosilo.tokens.afu`, written `AFTER_FIRST_UNLOCK`: a
  separate service because expo-secure-store's re-save of an existing item updates only its
  data, never its accessibility. `getSecure` moves an old item on first read (write the new,
  read it back, and only when it reads back equal delete the old; never delete first);
  `deleteSecure` deletes both; `AUTH_STORAGE_VERSION` is untouched, so nobody re-pairs.
  **A locked hydrate waits** (`session.ts`): a hydrate that fails only on the locked keychain
  (`isLockedKeychainError`, "interaction is not allowed") keeps `status` on `loading` (screens
  show their spinner, never the connect screen) and retries every `LOCKED_RETRY_MS` (5 s) and on
  the foreground; any other failure is `unauthenticated`. While `sessionHydrateFailed()`,
  nothing may treat the empty connection list as real (the offline queue keeps its saves, car
  bookmarks are kept, the car snapshot isn't rewritten as signed out).

**Chromecast (Phase 8, capability `cast`, `src/cast/`)**: react-native-google-cast 4.9.1 on
native (the Default Media Receiver; `plugins/withCast.js`, listed before `withCarPlay`, pins the
Cast framework and keeps the SDK's own notification on Android, whose foreground service keeps the
app saving while Media3 is unloaded), the Cast Web Sender on web (Chromium on https only, loaded
on first need). NOT device-verified (no Cast device yet).
- **A route, not a second player (decision 7).** `createPlaybackService()` returns
  `routed(engine)`: a `RoutedPlaybackService` forwards every call to the phone's engine or,
  while a session is connected, to the `CastPlaybackService` over that session's `CastRemote`,
  and forwards only that route's snapshots, so the store, `book-queue` and `progress-sync` drive
  a cast exactly as they drive the phone. Switching is a pause on one side and a paused load on
  the other: the router emits `paused` at the handed-over place (the store saves it); a cast
  started while playing plays on, and the phone never plays by itself when a cast ends.
  `startCastSync` (root layout) follows the driver's session events; `endCastForCar` and
  `stopCasting` end a session from the app.
- **The receiver never gets the session token**: `prepareCast` builds the queue with cast tokens
  (`POST /cast/token`, book-scoped, 24 h; `castTokens` caches one per book until an hour before
  it expires, drops expired ones and forgets a removed connection's), on the connection's address
  in use (`effectiveUrl`), and refuses with `CastBlockedError` (no `cast`, an address another
  device can't reach, a codec neither the receiver nor the server's transcoder handles). A
  downloaded book casts from its server. The web's Remote Playback prompt is NOT used (it would
  hand over the element's URL, token included).
- **Generations**: the cast service numbers loads (`loadSeq`) and queues (`queueSeq`), the router
  its switches (`generation`): a load, queue or handover that a newer one (or a reset) overtook
  stands back, and the receiver's rejection of a replaced queue is not a failure. The native
  driver drops a start reported after its session ended.
- **Foreign media** is told by stream address (`streamIdentity`: the route and its `path` /
  `transcode`, whatever base, token or `t=`): another sender's book or another app's media on the
  receiver is ignored (never paused, stopped or saved as ours) until this device loads again. On
  the web only the tab that started a session follows it (`sessionStorage`; other tabs leave
  the origin's session without stopping the receiver).
- **Transcoded streams** can't seek on the receiver: a seek or a jump to another file reloads
  the queue from there (`&t=`, the offset added back to every place read); an idle `finished`
  before the last file's end is a stream that died (`isEarlyTranscodeEnd`), reloaded at the
  place, never the book's end. Not while casting: Smart speed, Voice boost, auto-rewind and the
  volume (the sleep timer's fade would set the TV's).

**Widgets and the Live Activity (iOS only)** (`src/widgets/`, `expo-widgets` 56.0.27, whose
Android side is a stub, so `widget-sync.ts` is the no-op everywhere else).
`continue-listening.tsx` and `sleep-timer-activity.tsx` are `'widget'` functions:
babel-preset-expo turns each into a source string the extension evaluates in its own
JavaScriptCore with `@expo/ui/swift-ui` as globals. So **no hooks, nothing from module scope,
imports only from those modules under their original names, the system font, and every string
arriving in props, already localized.** `widget-model.ts` (pure, tested) decides what to write
and when; `widget-sync.ios.ts` (`startWidgetSync`, root layout; it requires expo-widgets lazily
behind a native-module check, since importing it on an older binary throws) rewrites the widget
on a book, chapter, play/pause or speed change, a jump over 30 s, a stop and once a minute while
playing, coalesced per `MIN_WRITE_MS`, with covers written into the widgets directory once per
book (the extension can't fetch; only when `fitsCover` says the file is small enough, as there is
no resizer). The Live Activity starts only in the foreground (ActivityKit's rule), ends
immediately when the timer fires or is cancelled, and has no buttons (expo-widgets has no
`AudioPlaybackIntent`, so a button would run in the extension and never reach the player).
`plugins/withWidgetsNoPush.js` strips the `aps-environment` expo-widgets 56 adds
unconditionally (the app sends no push, and every profile would otherwise need the capability);
it and `withXcode26SwiftUICoreFix` are listed BEFORE `expo-widgets` so they run after it. A
store build needs the App Group `group.app.audiosilo` and the extension `app.audiosilo.widget`
provisioned. **A dev build beside the store app needs its own ids** for the app, the extension
and the group, edited after prebuild (the list is in the docs' Testing page); a half-patched
build signs but shows an empty widget.

**Links into the app keep their encoding** (`src/app/+native-intent.tsx`, `redirectSystemPath`;
the rule is `appLinkPath` in `src/lib/native-intent.ts`): an `audiosilo://` link (the widget, the
Live Activity, a pairing link) becomes a plain path before Expo Router sees it, because Expo
Router decodes an app-scheme URL's query values and joins them back unencoded, which split a path
holding `&`, `#`, `+` or `%XX` ("Austen/Pride & Prejudice"). The development client's own links
pass through as they are.

**Tests** - new logic ships with a unit test. Pure, framework-free modules get
direct tests: `src/api/client.ts`, `src/lib/*`, `src/playback/book-queue.ts` +
`progress-sync.ts`, `src/stores/*` (see the co-located `*.test.ts`). Keep logic out
of `src/app/**` screens so it stays unit-testable. Harness: **jest-expo (jest 29)
+ @testing-library/react-native 14** - matchers are built in (no `jest-native`);
`jest.setup.ts` provides in-memory mocks for `expo-secure-store` + AsyncStorage,
and tests mock `fetch` / `@/api/reachability` as needed. Flip `Platform.OS` at
runtime to cover web-vs-native branches. **Jest proves nothing about Swift or Kotlin.** The
native module's pure parts have checks of their own that need no device: the Android JVM tests
(`TimelineMapTest`, `NarrationSilenceProcessorTest`, `VoiceBoostProcessorTest`; after an
Android prebuild, `./gradlew :audiosilo-player:testDebugUnitTest` under JDK 17) and the iOS
host self-check for `ChapterClips.swift` + `VoiceBoostDSP.swift` + `CarArtworkPath.swift`
(`modules/audiosilo-player/ios/SelfCheck/run.sh`, Xcode toolchain only). Android Auto needs the
Desktop Head Unit, CarPlay the Simulator, and lock
screens, the effects by ear, widgets and the locked-phone token read a device; the docs' Testing
page has the steps.

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
- **The keyboard over a bottom-anchored overlay** (`useKeyboardAvoidance`, `src/lib/keyboard-lift.ts`,
  used by `Sheet` and the phone `Dialog`): the panel rises by how much of the WINDOW the keyboard
  covers, the keyboard frame's SCREEN top (`endCoordinates.screenY`) against the window height, on
  both platforms (`keyboardOverlap`, then `keyboardLift` net of the home-indicator padding), and its
  height is capped to what the keyboard leaves under the top safe edge (`keyboardCap`), so the title
  stays on screen and the body scrolls. iOS lays the keyboard over the window; Android edge to edge
  (SDK 56, Android 15+) no longer resizes the window either, so `adjustResize` alone is not enough
  (the Phase 4 device pass caught the Android sheet hidden behind the keyboard). A window that DID
  resize ends at the keyboard's top and reads 0, so nothing lifts twice. Don't reach for
  `KeyboardAvoidingView` inside a portal or `FullWindowOverlay`: absolutely positioned there, it
  measures nothing useful. The web is the browser's business (always 0).
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
src/app/(app)/(me)/you.tsx                      /you        (the "Me" tab: the You hub, `?section=`)
src/app/(app)/(home,library,search,offline,me)/_layout.tsx    one Stack per tab (array group)
src/app/(app)/(home,library,search,offline,me)/{book/[libraryId],library/[libraryId],library/favourites,account,browse}.tsx
src/app/(app)/(home,library,search,offline,me)/{series,author,narrator,collection}.tsx   Phase 2 detail pages
src/app/(app)/(home,library,search,offline,me)/journal.tsx    /journal (Phase 4; older links, the hub has the Journal)
src/app/(app)/(home,library,search,offline,me)/settings.tsx   /settings (pushed on the current tab by the gear)
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
  active tab again: `popTabToRoot(tab)` (`src/lib/root-stack.ts`, `POP_TO_TOP` on that tab
  stack's key), which keeps the root's own params; never a navigate to the root's href (a
  navigate is a push in this router, so it stacked a second root over the pages).
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
- **The You hub is the Me tab's ROOT** (`/you?section=stats|year|journal|settings|household|account`,
  `src/components/you/you-hub.tsx`, rules in `you-model.ts`; `section` and the Journal's `tab` are
  its `rootParams`). Open it only through `openYou(section)` / `openJournal(tab)` (`src/lib/open.ts`,
  also on `useOpen`; never `pushInShell`): they close a root modal, pop the Me stack to its root
  (`popTabToRoot`) and `navigate`, so the hub never gets a second copy pushed over it and is never
  looked for in another tab. Inside the hub, sections switch with `setParams` (`youSectionParams`).
  The phone hub sets its large title per section (`navigation.setOptions`; a section then leaves
  that name out of its own heading); the wide sub-nav keeps "You". Its sections are `StatsSection`,
  `YearSection`, `JournalScreen`, `SettingsContent`, `HouseholdPage` and `AccountSection` (the
  `SECTIONS` map): Stats, Year, Household and Account are plain columns the hub puts in a
  `TabPageScroll` (below); the Journal and Settings scroll themselves. An active module's sections follow the hub's own (Slots, under Player modules). The tab bar says "Me" with a person (`labelKey`, `icon`), the top bar
  "You" with a chart (`wideLabelKey`, `wideIcon`).
- **Settings is a page of the array group** (`/settings?section=`, `settingsHref`), pushed on the
  current tab by the top bar's gear, the profile menu and the palette through `openSettings(section)`
  (on the Settings page already it only moves the pane), so back returns where the listener was and a
  cold link lands in Home. `SettingsContent({ section, onSectionChange, embedded })`
  (`src/components/settings/`, rules in `settings-model.ts`) is also the phone hub's Settings
  segment.
- **A tab page's scroller is `TabPageScroll`** (`src/components/shell/tab-page-scroll.tsx`; a
  FlatList or FlashList spreads `TAB_PAGE_SCROLL_PROPS` and pads by `useMiniPlayerInset()`): the
  page gutters, the floating mini player's room and `contentInsetAdjustmentBehavior: 'automatic'`.
  iOS lays a tab page out under its translucent tab bar (and the iOS 26 accessory), and
  react-native-screens asks UIKit for that inset only on the FIRST ScrollView of the screen's
  first-descendant chain: on a page with sections (the You hub, the Library modes) that is the
  phone's horizontal segmented control, so without it the page's own scroller ran its end under
  the tab bar (the tap for the last row hit a tab). The hub's Stats, Year and Account columns, the
  Account route, Settings, the Journal list, the Library's Folders and Collections modes, the Books
  list and every `CoverGrid` use it; a new tab page scroller does too.
- **Every page names the browser tab (web)**: a pushed page or root modal calls
  `usePageTitle(title)` (`src/lib/use-page-title{,.web}.ts`, a no-op on native; `undefined`
  while its data loads, when the tab's name stands in), a claim held while the screen is
  FOCUSED (`claimPageTitle`, `src/lib/document-title.ts`), so Back names the page under it
  again. `DocumentTitle` (root layout, `src/components/shell/document-title{,.web}.tsx`) is the
  one writer of `document.title`: the book playing (`▶`), else the page, else the tab, then
  "· AudioSilo". `StaticDocumentTitle` bakes "AudioSilo" into the static HTML (a `<title>` in
  `+html.tsx` never shows: Expo's head manager puts its own first). A new page calls
  `usePageTitle` too.

**The Library tab root is the browse modes** (`src/components/library/library-screen.tsx`):
`/library?mode=books|authors|series|narrators|collections|folders` (absent = books; pure rules in
`library-modes.ts`: a mode whose capability - `browse_people`, `collections` - is known to be off is
not offered and a link to it falls back to Books). The mode is the root's own search param, which
`tabStackListeners` keeps (`Destination.rootParams`) while it still strips a cold link's leftovers.
Every mode but Folders (today's libraries-then-folders flow, `modes/folders-mode.tsx`) shows ONE
library: `useSelectedLibrary()` (the device-local `useLibrarySelection` store, persisted with
`persistedDocument`, purged through `onConnectionRemoved`, reconciled by the pure
`resolveLibrarySelection`: a pick that is gone falls back to the first library, an offline server
keeps its pick), chosen with `LibraryPicker` (hidden with one library). Each mode body is its own
file under `src/components/library/modes/`. The detail pages take query params too:
`seriesHref(cid, lib, { name } | { work })` (`name` = a local series: a `Book.series` or one of
its `series_list`, `useSeriesBooks` numbering each book by that series (`inSeries`); `work` = a community
work id whose rails to show), `authorHref` / `narratorHref(cid, lib, name)` (exact field values),
`collectionHref(cid, id)`, with `parse*Params` and `useOpen().open{Series,Author,Narrator,Collection}`.
In Collections mode the picker names servers only (`LibraryPicker by="server"`, hidden with one
server): collections belong to a server, not a library. The sections are a scrolling
`SegmentedControl` that keeps the chosen segment in view and fades the side with more (a tablet's
sub-nav can't fit all six).

**Library Books mode** (`modes/books-mode.tsx`, rules in `books/books-view.ts`): `useWholeLibrary`
(`useAllLibraryBooks`, one cache entry per library) pages through the selected library 200 books
at a time until `next_cursor` runs out, then filters
(status from the listener's progress, Downloaded from the registry, length buckets, and a genre
and a tag matched case-insensitively by `labelKey`, which mirrors the server's `catalog.labelKey`;
it, `bookLabels` and `LABEL_KINDS` live in `src/lib/labels.ts`, shared with the book page, and the
server sends each list already clean, so nothing re-cleans it) and sorts on the device. The genre and tag
filters (`books/label-filter.tsx`: a picker chip opening a dialog of `labelOptions`, each counted
among what the other filters keep) show only when a loaded book has one or the URL names one, so
an older server, which sends neither list, shows no new control. The URL is the contract other
screens link to (`libraryBooksHref`): `/library?mode=books&sort=&status=&dl=1&len=&genre=&tag=`
(`libraryModeHref`; a book page's genre and tag chips open it through `openLibraryRoot`). Grid or list is remembered per device (`books-layout-store.ts`,
`audiosilo.booksLayout`); Title sort adds letter heads and an A-Z rail. **Book actions**
(`books/book-actions.tsx`): `useBookActions` (Play/Resume, Up next, Add to collection, download,
Mark as finished / not finished with Undo where `progress_edit` allows, More in this series) is
presented by `BookActionsMenu`: a dropdown on tablet/desktop, a sheet on a phone, plus the dialogs
its actions open (Add to collection, the shared `RemoveDownloadConfirm`). A list row has
`BookActionsButton` ("..."); every `CoverTile` opens the same menu itself (`tile-actions.tsx`) on
long-press, right-click, the Menu key or Shift+F10 (`useContextMenuRequest`, `src/lib/context-menu`)
and a screen reader's "More actions", anchored to the tile's corner, with the screen's `book` row
when it has one (else one item fetch). **Collections** (`modes/collections-mode.tsx`,
`collection-screen.tsx`, `collections/`): Favourites first, own and shared collections, New
collection; the owner edits, shares read-only (not for demo accounts), reorders with positioned adds
(Move up / Move down), removes by the item's own path; a viewer can Leave.

**Series, author and narrator pages** (`src/components/series/`): `series-model.ts` builds ONE
ordered entry list from the owned books plus, when `useBookMeta` matched one of them, the rail in the
chosen reading order: `owned`, `elsewhere` (a copy on another signed-in server, found by title and
author) or `ghost` (a community entry nobody has; a local gap without community data is only
"Book 3"). A series position may be a RANGE (an omnibus of books 1-3: `Book.series_index_end`,
`SeriesMembership.position_end`, a rail entry's `"1-3"`; older servers send none): read, show
and compare positions only through `src/lib/series-position.ts` (`parseSeriesPosition`,
`bookSeriesNumber` -> "1-3", `spanCovers`; a range only within the server's bounds). A range is
one entry at its start and holds every slot in it (no local gap; a rail ghost inside a copy's
range is left out); a single position never hides a ghost; the server places an owned omnibus
on the single rail entry it starts at (and on its range entry when the rail lists one): it
shows its range there (`placedPositionLabel`, also Up next's community answer) and is one
entry; "previous books" takes an omnibus only once it ends before the current work. The page
draws it as a bookcase (`bookcase.tsx`, `spine.tsx`): spine sizes and title fit
are the pure `spine-fit.ts` (text is estimated from a per-font advance table, never measured),
colours `spine-colors.ts` (the cover's colour, else a cloth colour from the title,
`src/lib/monogram.ts`). Then the entry list with each entry's one action (`entry-actions.tsx`:
Resume chapter N, Play, `QueueButton`, Open on <server>, View on AudioSilo Meta), the "Keep ahead
offline" card (the one `keepAhead` setting, only where the device can download) and the CC0 credit.
Series mode cards (`series-card.tsx`) show a `MiniShelf` of the owned spines and fetch their books
only once on screen, the cards on screen together in one request on `series_books`
(`useSeriesBooks(..., { batch: true })`; the series page asks plainly and reuses the cache); Search reuses
the card. Authors / Narrators modes and the person pages are
`people-mode.tsx` / `person-page.tsx` over `people-model.ts` (letter heads, portraits, books grouped
by series).

**Home** (`src/components/home/`, rules in `home-model.ts`, `listening.ts`, `now-card-model.ts`):
aggregated over every signed-in server, each book keeping its own connection. The Now card is the
loaded book, else the latest in progress (chapter scale, time left at the book's speed, a finish
date from `user_stats` when there is enough listening, Who's who / Story so far opening the book
page on that tab via `?tab=`); This week (`user_stats`) counts the streak in SERVER time; Next in
your series uses `next_book` (a work without `local` is a ghost opening the series page); smart
shelves link to Library Books with the URL params above. The sync pill reads progress-sync's
offline queue length without changing progress-sync (decision 7).

**Your listening** (`src/components/you/stats/`, rules in `stats-model.ts`): `StatsSection` is the
You hub's Stats section. It shows one server's own listening in that server's time (the default
connection, or a picker when two or more signed-in servers have `user_stats`: `useStatsServer`, on
`statsServerChoice`, shared with Year;
a server without the flag gets a Notice). It reads `useMyListening('1y')` (header, week, streak,
calendar, weekly bars) and `useMyStats('year')` (longest streak, daily average, clock, rank lists,
finished shelf, the Year banner), and saves the goal through `useSetListeningGoal` /
`useClearListeningGoal`, one PUT per -/+ step. Charts are react-native-svg drawings with no chart
library; each is one `image` with a text summary and reads without hover: `ChartPointer` reports
the web pointer or a tap in the chart's own coordinates, pure hit tests (`calendarCellAt`,
`petalAt`, `barAt`) pick the item, `ChartTip` draws the ink tooltip. The section has no scroller or
gutters of its own and lays out by its measured width (`statsColumns`). Rank rows open the
author/narrator/series page in a guessed library (`libraryForName`), because the stats name only the
field value. The Year banner and header button go through `openYou('year')`.

**Year in listening** (`src/components/you/year/`, `YearSection` in the You hub; the phone's
full-screen story is the root modal `src/app/year.tsx`, opened with `router.push(yearHref(...))`
from `src/lib/paths.ts`; its params back through `parseYearParams`). The cards come from one
server's own stats in server time (`useYearStory`: `useMyStats(range)` for the year, `range=year`
this year or `YYYY`; for this year also the running streak from `useMyListening('1y')` and the
goal). The pure `buildYearCards` leaves out any card without data, and a year under an hour with no
book finished is a calm empty state. Earlier years come from one query, `useStoryYears` (the pure
`findStoryYears`, asking back year by year; past years are kept for the session). The section and the
full-screen story share `useStoryStage`. `StoryCard` is the ONE renderer: the stage lays the bars and tap zones over it, and a share
captures it (`share-card.ts`: react-native-view-shot to a 1080x1920 PNG, then expo-sharing;
`share-card.web.ts`: html-to-image, lazy-loaded, then the Web Share API or a download, CSP-safe
because covers are plain `?token=` URLs on the web, `BookCover`, never `blob:`). A
failed capture is retried once with plain covers. There is no share link (it would need a server
endpoint). The story clock is `useStoryPlayer`: a plain timer for the advance plus a Reanimated bar;
it is held by a share (one that leaves the app holds it until the app is active again), a native
screen reader, a press, hover or keyboard focus, and reduced motion makes it still.

**One play path** (`src/components/player/use-play-book.ts`; the rule is the pure `playRoute` in
`play-route.ts`, fed by `navFor`, which reads the navigator at the press, never subscribed):
`usePlayBook()` with `{ at, toggle, viaBookPage }` is how Home, the Library, the series page, Up
next, the book page and the jumps (bookmark and note rows, history spans and drift strips, all
through `useJumpTo`) start a book or move into one. A `toggle` on the loaded book pauses or plays
it in place on every layout. Otherwise a phone opens the full player (`playerHref(cid, lib, path,
place)`, which the route applies once) - **also for the playing book, so a jump there opens the
player on the place** - first pushing the book page under it with `viaBookPage` unless that page
is already the one on screen. A tablet or desktop, and every layout while the full player is
already on top (Up next's sheet over it; pushing `/player` over the open one stacked a second
player), plays the loaded book on (`seekBook` to `at`, so the Undo chip offers the way back,
resuming a paused one) or starts another in place under the docked bar through its own connection
once its chapters are in (`startBookInPlace`, at `at`). It rejects when the book can't be fetched,
so the caller can say so (`useJumpTo` toasts).

**Bookmarks and notes** (`src/components/annotations/`, the barrel exports only what outside
callers use; rules in the pure `labels.ts`, `drift-marker.ts`, `editor-model.ts`). Adding a
bookmark stays one tap: `addBookmarkHere` (the dock, the player, B) bookmarks the live place and
its toast offers **Add note** where the server has `annotations` (an older server can't edit the
bookmark it made); a book page's `AddBookmarkAction` does the same while that book is the placed
one (`selectPlacedBookKey`), else opens the editor at the listener's place (`usePlaceIn`). The
editors (`AnnotationEditorSheet`, one frame and one save runner for both kinds) open through the
player sheets: `usePlayerSheets().openEditor(request)` sets `open: 'editor'`, the request types
and `editBookmarkRequest` / `editNoteRequest` live in the neutral `src/lib/annotation-request.ts`
(so the sheet store and the components don't import each other), and the request carries its own
book, so it works for any book on any connection and is **never dropped when the playing book
unloads** (`dropsWithBook`: closing it would throw away what the listener is typing). Notes are
pinned to the listener's place when made; a note at 0 is a legacy one (older apps wrote every note
at 0), so `pinsOf` draws no pin for it (they stacked on 0:00 and pulled taps there) while the lists
still show 0:00. One row, `AnnotationRow` (`BookmarkRow` / `NoteRow`), and one section per book,
`AnnotationSection` (the book page's `BookmarksSection` / `NotesSection` and the companion's
tabs), with `chapterNamer` / `useChapterNamer` naming the chapter. Delete is immediate with an
Undo toast that re-adds the row (`useDeleteWithUndo`): another device and the pins agree at once
and nothing waits on a timer an app suspend could stop; the cost is a new id and date. A
"Fell asleep" marker is `isDriftBookmark`: label `fell_asleep`, or (no label: an older server, an
older bookmark) the sleep timer's note in ANY of the six locales, read from the i18n resources
(the note is stored translated at the time). A Quote renders italic in the body face inside the
locale's quote marks (`annotations.quoted`; Fraunces is not bundled). Small row actions and chips
take `touchTarget` (below).

**The Journal** (the You hub's Journal section, `/you?section=journal&tab=diary|bookmarks|notes`;
`JournalScreen` with `embedded` under the phone hub's title; the array-group route `journal.tsx`
still names it for older `/journal?tab=` links; `src/components/journal/`; `parseJournalTab` in
`journal-model.ts`). Entry points go through `openJournal(tab?)` (or `openYou('journal')`): the
hub's segment, the profile menu, the palette's Go to, and each book section's `JournalLink`. It lists EVERY signed-in server's lists, each through its own connection and gated
on its own flag (`useJournalSources`): one infinite query per server and list through
`useInfiniteQueries` (`src/lib/use-infinite-queries.ts`, TanStack has nothing for a growing list of
infinite queries; one `InfiniteQueryObserver` per query hash), merged by `mergeNewestFirst`
(`merge-model.ts`: a k-way merge of the newest-first heads, cut at the hold-back boundary, the
newest oldest-loaded row of any server with more pages, since anything older could still have a
newer neighbour on that server's next page; a loading, failed or unsupported server never holds
the others back). The Notes list is held back (`enabled: false`) until its tab first opens; the
Diary shows none. **Sessions** (`src/lib/listening-sessions.ts`, shared with the book page's
History tab so the two agree): spans of the same book on the same server join while the pause is
under 10 minutes (`SESSION_GAP_MS`) and the positions are contiguous (a seek starts a new one),
placed on local days. **Drift strips**: `matchDrifts` (`diary-model.ts`) pairs each drift bookmark
with the session it ended (same book, made just after, near its end); with this device's drift
record still kept (`useDriftRecords`, read once) the strip offers "Jump back N minutes", and the
jump spends the record (`takeDrift`) so the strip then offers the bookmark, never a second jump.
**Export** (`use-journal-export.ts`, pure formats in `export-format.ts`): CSV (RFC 4180, a UTF-8
BOM, CRLF, `csvField`'s formula guard so a shared file opened in Excel never runs a note) or
Markdown grouped by book; native writes a file and opens `expo-sharing` (`export-save.ts`), the
web downloads it (`export-save.web.ts`) or copies the Markdown; only servers with `annotations`
are asked, at most 10,000 rows.

**Downloads page and automatic downloads** (`src/components/downloads/`, `src/downloads/`):
- **Keep the next books ready** (`keepAhead`: Off / 1 / 2 / 3, default Off; Downloads page, Settings
  and the series page bind the one setting through `rules-card.tsx`'s exports). The pure planner
  (`keep-ahead.ts`) takes the next N books after the loaded one (Up next first, then the series),
  obeys the network rule (`autoDownloadNext`), starts them in order and stops before free space would
  drop under max(1 GB, 10%) (`reserveBytes`; one at a time when the room is unknowable). The
  controller (`keep-ahead-controller.ts`, started once from the root layout) gathers the inputs and
  waits a moment after the book changes, so the store's own download of the book you start always
  goes first; it never changes the playback store.
- **The session decline mark**: cancelling or removing a download marks it declined until the app
  restarts (`isDeclined`, memory only); automatic downloads skip it, a listener's download lifts it.
- **One choke point**: `useDownloads.download(..., origin)` applies the automatic rules itself for
  the `auto` (the book you start) and `keep-ahead` origins: the decline mark and the reserve
  (`roomLeft`). Callers just ask with their origin; the listener's own download is never held back.
  It resolves what it did (`DownloadOutcome`). The book you start outranks keep-ahead's books still
  waiting (they step aside, unmarked, and it goes next); keep-ahead plans again at once around a
  book the store turned away (`unavailable`: web transcode; `tooBig`: no room until the registry
  changes).
- **Kept files**: a failed download keeps the files that finished (classified cause in
  `failure.ts`, `failure.kept`), and a retry fetches only the rest. `runOne` lists each finished file
  in the saved entry as it lands, and launch (`reviveEntry`) keeps a failed or interrupted download
  whose listed files are all still on disk (an interrupted one says the app closed); anything else is
  dropped with its folder. No storage format change.
- **Web**: the service worker now registers in the exported player even when the root layout loads
  after the page's load event (before, offline web playback never worked), and the download-support
  probe waits at most 10 s for a worker (it used to hang, offering downloads that couldn't play).
- Removing a download asks first everywhere (`RemoveDownloadConfirm`, with the room it frees).
- **Changed chapters**: a book's chapters can change on the server after it was downloaded (a
  rescan, a community chapter list, `chapters_source: "community"`). `startChapterRefresh` (root
  layout) watches the query cache: a server answer for a downloaded book's chapters replaces
  `manifest.chapters` when its audio files are the ones on the device (`refreshedChapters`: same
  paths, same order, same sizes where both answers know them); otherwise the manifest stays (that
  is a new download). An answer that reached the cache before the book was downloaded (while its
  files did, or before launch's `hydrate`) is taken as it becomes downloaded (`withCachedChapters`).
  The audio is never touched, and a queue already playing keeps its chapters until the book is
  next started. The same files in another order (server v2.4.0 plays them in natural order, "2-"
  before "10-") are taken **only by a start that loads the engine in that order**
  (`adoptStartedChapters`, from `playBook` once its load landed and it still owns the engine;
  saved at once), never from a background answer: JS sees only what it loaded, not a book the
  Android service or a Cast receiver holds before `adoptLoaded` / the receiver adoption, which map
  the engine's track index through the manifest. So an offline start, Android's no-JS car start
  and `adoptLoaded` keep the manifest's order until an online start plays the new one. The
  chapters carry the order (every queue over a download orders its files by them and finds each by
  path); `manifest.files` itself never moves, since a file's index there is its name on disk
  (`fileName`, rebuilt by `relocateEntry` at every launch and by a retry). A place saved on the old
  timeline reads as moved once the new order is taken (as the server's re-index moves any
  whole-book place: no remap). A downloaded book whose chapters change gets its Android car play
  spec rebuilt (`car-controller.ts`).
- **Offline companion** (`src/downloads/offline-meta.ts`): a downloaded book keeps its community
  metadata (asked by `metaEnabledFor`, so a book with content generated on its server too; the `/meta` envelope, plus the previous work(s) the envelope doesn't hold) as
  `meta.json` beside its audio (`engine.writeText`: the book's folder on native, its Cache API
  prefix on web), so it is scoped by connection and deleted with the files. **Not in the registry**:
  that is ONE JSON document rewritten every couple of seconds while a download runs, an envelope
  can be hundreds of KB, and AsyncStorage on Android / localStorage on web cap the whole store at a
  few MB; the registry carries only a marker (`DownloadManifest.meta`). The seeds fill exactly the
  keys the readers use (`qk.bookMeta`, its `includePrevious` variant when fetched that way,
  `qk.metaWork`, and the store's own `qk.item` / `qk.chapters`) through `seedQuery`: never over
  data the cache already holds, dated by `savedAt` so an online screen still refetches on its own
  schedule, and kept for the session through `setQueryDefaults` (`gcTime: Infinity`; else a book
  downloaded an hour before the flight opens with nothing) until `releaseOfflineBook` on remove.
  Every reader first waits on the `metadata` flag, so each connection's last `/server` answer is
  kept under `audiosilo.offlineServers` (`OFFLINE_SERVERS_KEY`, in `SCOPED_STORAGE_KEYS`): a cold
  offline launch still knows the flags. The launch restore runs after first paint
  (`afterLaunch`), reads three files at a time, seeds the books before the server answers (so a
  gate it opens finds the data), then backfills downloads that kept none and refreshes copies
  older than a week (only servers with `metadata`; a failure keeps what the book had). The spoiler
  gate is unchanged: it still runs on the device.

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
floating `MiniPlayer` card elsewhere (`ACCESSORY_SUPPORTED`): 56 pt, inset 8 from the sides and
`MINI_PLAYER_GAP` above the bar, `rounded-card` + hairline + `shadow-overlay` (Android elevation). Both
show the chapter, the book with its time left (`usePlayingTimeLeft`; the sleep countdown first while a
timer runs, `MiniPlayerSubtitle`), skip back, the `plain` `PlayButton` (spinner, Retry) and the
`ChapterProgressLine`; the accessory's narrow `inline` placement keeps cover, chapter and play. On native that card is ONE
`FloatingMiniPlayer`, rendered by `(app)/_layout.tsx` as the shell frame's `phoneBottom` over
NativeTabs (never per tab stack: NativeTabs keeps visited tabs alive, so a card per stack ticked up to
five times), absolutely positioned on the native bar's measured `bar` edge, so it sits on the bar on
every tab and over pushed pages and a tab switch never remounts it; web puts its card on its own tab
bar. Tablet/desktop (web and native):
`TopBar` (64; mark + server line, Home/Library/Downloads/You, omnisearch, the Settings gear, `ProfileMenu`),
`SubNav` (50; title on a tab root, Back on a pushed page; tab roots leave their title to the
chrome; a tab root fills the rest with `SubNavSections` (its segmented sections) and `SubNavActions`
(contextual actions, keyed by id and ordered) from `tab-root-nav.tsx`, which publish into the
`useSubNav` store on tablet/desktop and render in place on a phone; published nodes render in the
sub-nav's tree, so they must not need the screen's context), banners, the page capped at 1480 (`CONTENT_WIDTH`), the `DrawerSlot` on desktop (Up next's drawer, below),
and `DockedPlayer` (84) whenever a book is loaded (nothing while the full player is on top, as for
the mini player and the accessory: `usePlayerOnTop`): the 3 px whole-book line, book + sync state
(`usePlaceSync`, shared with the full player's status line: sign in again > saved on this device
(offline, or saves queued) > synced / synced just now), `TransportControls size="sm"` over a chapter
scrubber with bookmark ticks (`usePlayingSegment`; the dock's one `usePlayingPins`), then `UndoChip`,
speed, sleep (`SleepTimerButton`, `useSleepPill`: `brand-soft` + countdown while running), bookmark
(`addBookmarkHere`), output (`canRoutePick`), Up next and expand. The player controls share one chrome
(`control-pill.tsx`: `pillClass` / `ControlPill`). What fits is decided by its MEASURED width
(`dockLayout`: all actions from 1024, the tablet set below, no scrubber below 800; everything hidden is
in the full player; while the Undo chip shows (`useUndoVisible`), its MEASURED width comes off the
width first and the right cluster stops growing, so the book keeps its title). Speed and sleep open
through `usePlayerSheets`; the dock mounts no sheets itself (the shell's one `PlayerSheetHost` does).
Route-driven side effects (search reset on leaving the Search tab, browse scroll memory) are
`useShellEffects`.
- **Full player** (`src/app/player.tsx` thin, `src/components/player/player-view.tsx`, pieces in
  `player-parts.tsx`, rules in `player-view-model.ts`): laid out by its MEASURED width (`playerLayout`).
  The cover washed into the background (`CoverWash` from the item's `cover_color`, else a neutral),
  breathing to 94% while paused; header (minimise, "Playing from <server>", series line, overflow
  `DropdownMenu`); chapter title (tap: asks for `chapters`, which the sheet host shows as the
  companion's Chapters tab on desktop and phone, the chapter sheet on a tablet);
  `PlayerStatusLine` (`usePlaceSync`, % of the book, time left) that becomes the `UndoChip`, gives its
  slot to the sleep timer's `GraceCard` (`inline`: in the flow, never over the controls) and fades
  while the seek bar's scrub/hover tip floats into it (`onTip`; while the chip holds the slot the
  bar draws no hover tip, `hoverTip`, since the click that made the chip leaves the pointer on it); seek bar (its times row hides under
  the timeline's tip the same way), compact timeline with bookmark and note pins (a tap on a pin lands
  on it), transport, actions (speed, sleep, bookmark, output, Up next on phone/tablet). The two
  scrubbers share `scrub-parts.tsx` (hover, `Playhead`, `ScrubTip`) and one `usePlayingPins` call; the
  timeline merges chapters like the Now card's `scaleRuns` but places each run by time (`runBox`, the
  mapping the playhead, taps and pins use). A scrub never lands on the book's very end
  (`scrubTarget`: 30 s short), which would finish the book and take the Undo chip with it.
  The **companion** (`companion/`: Who's who, Story so far, Chapters, Bookmarks, Notes, History) is
  a 420 column on desktop, inline under the controls on a tablet, a 78% sheet from chips on a phone
  (one row, a sideways scroller where it doesn't fit; the phone's column is a flex column whose cover
  slot takes what the rest leaves, `phoneCoverSize`, so the player fits without scrolling);
  gated by `useCompanionData` (the book page's `meta-gating` rules on the live position), one reveal
  per book and the "Just met" marks in `useCompanion`, the server's `attribution` on every community
block (`communityCredit`, Story so far's `recapMarks`; generated panels wear `GeneratedMark`,
Story so far its `recapMarks` chips, and Who's who / Story so far offer an admin `GenerateOffer`
under their empty state).
  `CompanionRevealListener` (root layout) toasts "New in Who's who" on a natural chapter crossing
  only (`watchReveal` + `revealOnCrossing`: a pause, a buffer or a file change reported in two
  writes on the way still counts; a seek never does), reading the chapter at Who's who's own
  exact place (`selectLivePosition`) and never announcing anyone the saved place already shows,
  so the toast and Who's who agree; Show reads whether the player is on top when
  pressed. Unknown `metadata` counts as off for the companion, as for the phone's chips. **Sheets**: `PlayerSheetHost` renders `usePlayerSheets` (speed, sleep,
  chapters, the companion through `openCompanion(tab)`, Up next's `upnext`, the annotation editor
  through `openEditor`; bookmark/output are actions), deciding the form from its layout (the full player's MEASURED one), all through one
  presenter, `PlayerSheet` (`body` `scroll` or `fill`); one host in the full player and one in the
  shell (`ShellPlayerOverlays`, with the floating `GraceCard` where a toast would sit; it publishes a
  `grace` chrome edge, so the toasts lift above it), and `hostIsActive` lets the shell's stand back
  while the player route is on top. A book's sheet request (speed, sleep, chapters, the companion) is
  dropped when the book unloads, so the next book never opens it by itself (the editor, which
  carries its own book, stays: `dropsWithBook`). Only the top app shell
  (`useIsTopShell`) mounts these overlays, the palette, the shortcuts overlay and the keys. **Never
  stack shells**: a page of the app shell opened from a root route (the full player, the credits)
  goes through `pushInShell` (`src/lib/open.ts`; `useOpen` does it), never `router.push` or
  `router.replace`, which would put a second `(app)` over the first. Code that must know where the
  player is at a press reads `topRootRoute(currentNavState())` (`src/lib/root-stack.ts`) instead of
  subscribing with `usePlayerOnTop`. **Touch targets**: a rem is 14 pt on native, so a rem-sized
  control (`h-11` = 38.5 pt: the player controls) takes `hitSlop={slopTo44(rem)}` (`src/components/ui/touch-target.ts`;
  zero on the web for 2.75 rem), and a small one (a chip, a row's icon action) takes
  `touchTarget(h, w?)` there instead: a real 44 pt frame on native (`frameClass`: a slop grows the touch but
  not the frame, which the accessibility tree reports and device audits measure), a slop on the web; tests assert both with `expectNativeTarget` (`src/testing/touch-target.ts`). The
  sync line (`usePlaceSync`) counts only the playing book's server's queued saves and polls while
  playing (a 5xx save queues with the server still online). The player keys stand back over any open layer (`isModalOpen`: an
  `aria-modal` `Sheet`, or a Radix Dialog, AlertDialog, menu or select, which say so with
  `data-state="open"` and no `aria-modal`); Space stands aside for a focused control Space activates
  (`ownsSpace`: a button, a tab...) and the arrows for one that moves with them (`ownsArrows`: a
  slider...), so Space still plays and pauses over a focused scrubber. The scrubbers ignore
  gesture-handler's keyboard pointer (`PointerType.KEY`, a press at the centre it makes up for Space
  and Enter on the web), scrub only on a sideways drag (`activeOffsetX`/`failOffsetY`, `pan-y` on the
  web) and never commit a cancelled drag.
- **Previously on** (`home/previously-on.tsx`, rules in `previously-on-model.ts`): above the Now card
  when its book was last played 12+ days ago and a community recap reaches the listener (the Story so
  far gate); "Resume, with 30 seconds of overlap" (`resumeWithOverlap`) starts 30 s before the NEWEST
  saved place at its speed: the resume lookup (`loadInitialProgress`: the server, the local mirror and
  the offline queue) against Home's server row, since a start at an explicit position skips the
  store's own reconciliation. The card is dark in both themes through `ScopedThemeColors`
  (`use-theme-colors.tsx`), which also hands the dark colours to `useThemeColors` below it, so colour
  props (a Button's spinner, icons) follow the scope as classes do.
- **Command palette (web only)**: `CommandPalette` (`command-palette.tsx`), mounted once by the web
  shell on the Dialog primitive, opened by the omnisearch (web tablet/desktop; a native tablet's
  omnisearch still jumps to the Search tab and focuses it), ⌘K / Ctrl+K or `/` (`usePaletteShortcut`:
  never while typing in a field, over another dialog, or over the player modal; those guards are
  `useGlobalShortcut` in `src/lib/keyboard.ts`, shared with Up next's Q). `usePalette`
  (`palette-store.ts`) holds open and the query; the recent searches are the Search screen's
  `useRecentSearches` (`src/stores/search.ts`, persisted per device under `audiosilo.paletteRecent`).
  Which items show, the grouping, the arrow-key clamp and the shortcut test are the pure
  `palette-model.ts`; the Actions list is its `buildActionItems`. Content is only what exists: Actions
  (pause / "Resume <chapter>", sleep in 30 minutes, sleep at end of chapter - only with real
  chapters -, open the full player, Open Up next with the queued count - only where the queue's
  server has `queue`, through `openUpNext()` -, switch light/dark), Books from
  `useSearchAll` (debounced, `useDebouncedValue`; sources
  from `useSourceLabeller`; empty query: Continue listening from the cached `useAllProgressAll` with
  `refetchOnMount: false`, disabled while a query is typed, `isInProgress` shared with Home), Go to (the
  top bar's destinations, `TOP_BAR_TABS`, already filtered to what this browser can do, then Your
  listening, Year in listening, the Journal and Settings: `buildGoToItems`). A book opens
  with a plain push, so it lands in the current tab. With a query it also lists Series, Authors,
  Narrators and Characters (three each) from the Search screen's model (below), and counts the
  characters not met yet in a note row that is not an option.
- **Up next** (`src/components/upnext/`, capability `queue`; nothing renders while `/server` is unknown):
  the desktop drawer in `DrawerSlot` (open by default, 300-480 wide by its left edge, both remembered
  per device in `up-next-store.ts`) and the same `UpNextPanel` in a player sheet on tablet/phone
  (`usePlayerSheets`' `upnext`, rendered by `PlayerSheetHost`). Entry points: `UpNextButton` in the top bar, the dock and the phone header
  on tab roots; Q on the web (`useUpNextShortcut`); `openUpNext()` / `toggleUpNext()` for anyone else. It
  shows ONE connection's queue: the loaded book's, else the default (`queueConnectionId`). Every write keeps
  hidden rows: a reorder (grip drag via gesture-handler, arrow keys on the grip or Alt+arrows, screen-reader
  Move up/down) is a positioned add with the visible index, Clear is exact-path deletes with one Undo.
  Play now goes through the shared `usePlayBook` (below). Web
  desktop covers (`CoverTile`) are HTML5 drag sources (`drag-source.web.ts`) for the drawer's drop zone,
  which takes only a book from the queue's own server. The queue's head is what plays next
  (`resolveUpNext`: the queue, then the server's `next_book`, then the folder); the footer switch is
  `autoPlayNext`. Q closes the sheet it opened (the sheet carries `layer="upnext"`, which
  `useGlobalShortcut` does not count as a blocking layer). A row or a suggestion opens its page
  through `useOpen`, which from over the full player lands in the shell underneath (`pushInShell`).
  Pure rules: `up-next-model.ts`.
- **Search** (`src/components/search/`, the `(search)` tab): the field, then recent searches (ONE list
  with the palette, `useRecentSearches` in `stores/search.ts`, key `audiosilo.paletteRecent`) and
  Browse cards (the selected library's counts, opening the Library modes), or the grouped results
  (`useSearch`, shared with the palette): books from every server (`useSearchAll`, deduplicated),
  series/authors/narrators matched on the device against every library's browse lists
  (`usePeopleSources`, `browse_people`; a series result is the Library's `SeriesCard`, whose mini
  shelf fetches that series' books only once the card shows, batched with the other cards), and characters only once met (`useCharacterSources`: the
  community characters of the newest 8 started books on `metadata` servers, each gated by the
  listener's place in THAT book with `meta-gating`'s rules, chapters fetched only for unfinished
  books with characters, "from the start" until they arrive). The pure `search-model.ts`
  (`matchNamed`, `matchCharacters`, `listeningIn`) is where spoiler safety lives: an unmet character
  is only ever counted ("2 more matches after your place in the book", i18next `_one`/`_other`), never
  named, also not via an alias, and a name met in any book is not counted again.
- **Profile menu** (`profile-menu.tsx`, tablet/desktop top bar): each server with its state
  (`serverStatus` in `src/api/reachability.ts`, also the top bar's server line and the dock's
  saved-locally line: needs signing in again > offline > signed in as), opening its account screen;
  Add a server (`/connect?add=1`; not on the served player, `onlyOwnServer`); the Journal; Settings;
  the account on the default server; a light/dark switch. Phone keeps these in the Me tab's You hub.
- **Toasts** clear the bottom chrome: each piece publishes its measured TOP edge (distance from the
  window's bottom) into `useShellMetrics` with `useChromeEdge` - `bar` (the web tab bar by layout; the
  native bar from the tab stacks' layout: iOS's bottom inset there, Android's gap between the page's
  and the shell frame's bottoms, both from `measureInWindow` (`nativeBarEdge`; Android's
  `measureInWindow` is offset by the status bar under edge-to-edge, so comparing with the window
  height made the bar a status bar too tall); each stack publishes only once it has measured),
  `mini` (the floating card: bar + its height), `accessory` (the iOS 26 pill, measured in the window),
  `dock`, `grace` (the sleep timer's floating card, above the rest while it shows) - and the root `ShellToastHost` passes `<ToastHost bottomInset>` from the pure
  `toastBottomOffset` over `bottomChromeTop` (the highest piece; one fallback before the first layout;
  tablet/desktop with nothing loaded and over a root modal: just above the home indicator). The web mini
  player sits on its tab bar through a `100%` bottom offset, no measured height. The accessory renders
  nothing on tablet/desktop (iOS mounts both placements behind the hidden bar).
- **Banners**: `OfflineBanner` takes the page's connection as a prop (each phone header its own
  route's `?connection=`, the wide `WideTop` the focused page's) and selects only which message shows.

