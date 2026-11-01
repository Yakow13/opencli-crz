# CRZ adapter test suite

Three tiers, all offline except the live gate:

| Tier | File | Touches network? |
|---|---|---|
| Parsers & formats | `parsers.test.js` | no — fixtures + `helpers/synth.js` |
| Request contract (outgoing URLs, error types, exit codes) | `requests.test.js` | no — `helpers/fetch-stub.js` serves fixtures |
| Stateful machinery (harvest, profile, evidence, cache) | `aggregates.test.js` | no — synthetic pages + child-process probes |
| Live drift detector | `live.test.js` | only with `CRZ_LIVE=1` |

```sh
npm test                 # node --test test/*.test.js
npm run coverage         # + --experimental-test-coverage
npm run fixtures         # regenerate test/fixtures (deterministic, offline, synthetic)
CRZ_LIVE=1 npm test      # include drift detector (site does weekend maintenance)
```

## Rules that keep coverage honest
- **Tests drive production paths**: command defs are loaded via `helpers/commands.js`
  (real `cli()` registration), then `def.func(args)` — the same call opencli makes.
- **Never import `../utils.js?query=` in tests** — duplicate module instances
  collapse into one row in the coverage report and tank the numbers. Scenarios
  needing a fresh module or sandboxed `HOME` belong in
  `helpers/isolated-probe.mjs` (child process).
- **Page cache is off** during tests (`commands.js` sets `OPENCLI_CRZ_CACHE=0`);
  the cache behaviour itself is probed in an isolated child with `HOME=tmp`.
- **PRIVACY: the repo contains zero real register content.** Fixtures are a
  deterministic *synthetic universe* (`helpers/build-fixtures.js` header lists it)
  reproducing the exact structure observed live — because which entities a
  recording tool captures would itself reveal whom someone is investigating.
  Reality is verified only by the opt-in live tier (`CRZ_LIVE=1`), which stores
  nothing. Never paste real pages/ids/IČOs into fixtures, tests, comments or commits.
- Site quirks pinned by tests (regressions — do not "simplify" them away):
  - multi-word args arrive as literal keys: `args['min-amount']`, never camelCase
  - legacy contracts (pre-2011) link under bare `/<id>/`; `/zmluva/<id>/` 404s
    → `fetchContract` falls back; amendments lists mix both link kinds
  - amounts appear as span/span **and** strong/strong pairs outside the label grid
  - unknown contract ids return **HTTP 404 with a full styled page**
  - `/export/<old-date>.zip` exists for any date: valid ZIP containing an empty
    `<zmluvy/>` diff — size/magic checks, not 404 handling, detect "no data"
