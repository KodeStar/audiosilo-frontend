# AudioSilo Frontend

The audiobook **player** for [audiosilo-server](https://github.com/kodestar/audiosilo-server) —
one Expo / React Native codebase shipping to **web PWA + iOS + Android**.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and the full stack;
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

## Prerequisites

- **Node `24.16.0`** (pinned in [`.nvmrc`](.nvmrc); `nvm use`).
- **FontAwesome Pro token** in a gitignored **`.env`** as
  `FONTAWESOME_NPM_AUTH_TOKEN=...` (referenced by `.npmrc`). It must be in the
  process env to install `@fortawesome/*`:

  ```sh
  set -a; . ./.env; set +a
  npm install
  ```

## Develop

```sh
npm run web                     # expo start --web (no native build needed)
npm run ios | npm run android   # needs a dev build (npx expo prebuild first)
```

## Testing & CI

Run the same checks CI runs, locally:

```sh
npx tsc --noEmit            # typecheck (strict; must stay clean)
npm run lint                # eslint flat config (eslint-config-expo + prettier)
npm test                    # jest-expo unit tests
npm test -- --coverage      # …with coverage
npx prettier --write .      # format to .prettierrc (advisory; not gated yet)
```

Tests use **jest-expo** (jest 29) + **@testing-library/react-native** 14, with
in-memory mocks for `expo-secure-store` and AsyncStorage in
[`jest.setup.ts`](jest.setup.ts). Initial coverage targets the framework-free
logic: the API client, pairing parser, playback queue/timeline math, the offline
progress-sync queue, secure-store, and the session store. Add tests next to the
code as `*.test.ts`.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck + lint +
tests on every pull request and push to `main`, and **gates merges**. Its
`npm ci` needs the `FONTAWESOME_NPM_AUTH_TOKEN` repo secret (the private icon
registry). After changing dependencies, run `npm install` and **commit the
updated `package-lock.json` in sync** — CI uses `npm ci` (frozen lockfile). The
web-export image build ([`web.yml`](.github/workflows/web.yml)) stays separate.
