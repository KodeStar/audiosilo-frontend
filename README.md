# AudioSilo Frontend

The audiobook **player** for [audiosilo-server](https://github.com/kodestar/audiosilo-server) -
one Expo / React Native codebase shipping to **web PWA + iOS + Android**.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and the full stack;
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

## Prerequisites

- **Node `24.16.0`** (pinned in [`.nvmrc`](.nvmrc); `nvm use`).
- That's it - `npm install` pulls nothing private:

  ```sh
  npm install
  ```

  Icons are FontAwesome Pro glyphs **vendored as plain SVG** in
  [`src/components/ui/icon-data.ts`](src/components/ui/icon-data.ts), so building
  the app needs **no FontAwesome token**. A token is only needed to add/regenerate
  an icon - see [`scripts/glyphs/README.md`](scripts/glyphs/README.md).

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
npm run format              # prettier --check . (CI-gated; fails on unformatted files)
npm test                    # jest-expo unit tests
npm test -- --coverage      # …with coverage
npx prettier --write .      # auto-fix formatting before committing
```

Tests use **jest-expo** (jest 29) + **@testing-library/react-native** 14, with
in-memory mocks for `expo-secure-store` and AsyncStorage in
[`jest.setup.ts`](jest.setup.ts). Initial coverage targets the framework-free
logic: the API client, pairing parser, playback queue/timeline math, the offline
progress-sync queue, secure-store, and the session store. Add tests next to the
code as `*.test.ts`.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck + lint +
**format (prettier `--check`, via `npm run format`)** + tests on every pull request
and push to `main`, and **gates merges**. After changing dependencies, run
`npm install` and **commit the updated `package-lock.json` in sync** - CI uses
`npm ci` (frozen lockfile). The web-export image build
([`web.yml`](.github/workflows/web.yml)) stays separate.
