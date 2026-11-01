# AGENTS.md — operating opencli-crz from an agent

You (the agent) can install, verify, and run everything headlessly. Follow the contracts below — they exist because the CRZ website lies in specific, documented ways (§11 field review).

## Install & verify

```sh
# install (idempotent, updates in place; never needs sudo):
curl -fsSL https://raw.githubusercontent.com/Yakow13/opencli-crz/main/install.sh | bash

# verification contract — do this before answering user questions:
opencli list crz | grep -o '"command":' | wc -l    # ≥ 16 commands
opencli crz feed --limit 1 -f json                  # "ok":true → site reachable + parsers current
```
`feed` failing during a weekend = planned CRZ maintenance; retry, don't conclude the tool is broken.

## Recommended posture

1. **Bootstrap the mirror once**, then work locally (exact, fast, gentle on the site):
   ```sh
   opencli crz sync --since 2025-01-01        # ~0.9 s/day, resumable, prints gaps
   ```
   Mirror = `~/.opencli/data/crz/mirror.sqlite`. Without it, `entity`/`sql` degrade or refuse (Node ≥ 22.5 required for mirror commands; everything else runs on ≥ 20.18).

2. **Entity questions → `crz entity <IČO>` only.** Never answer "how much/which contracts" from a single `search --supplier-ico` — the register leaves supplier IČOs blank at the source (~33 % of rows), and legal names drift. `entity` unions both directions and tags every row `matchedBy: ico|name`.

3. **Before stating any number, check the envelope:**
   - `hasMore: true` → you have one page, not the answer — use `crz collect` (whole result set → JSONL)
   - `pageCount: null` → total is unknown mid-window; `pageWindowMax` is a lower bound, not a count
   - `usedQuery.attempted` longer than one entry → the naive query was a false negative; mention which variant worked
   - `postFiltered` → rows were client-side corrected (loose site LIKE / substring numbers)
   - `amountStated: false` rows: 0,00 € usually means unpriced framework ceiling, not free
   - `numberEcho: true`: the "number" column repeats the title — don't treat it as an identifier

4. **Flags for story candidates once the mirror has depth:** `crz flags` (when shipped) / plain `crz sql` over `contracts(sum_original vs sum_total, closed_at vs published_at…)`.

## Output hygiene & privacy (hard rules)

- Cache, mirror, collected JSONL live under `~/.opencli/` or your cwd — **never commit register content** (fixtures are a synthetic universe; real captures in git are a privacy incident, see test/README.md).
- CI/logs: assert shapes, discard payloads; never echo bulk results into shared surfaces.
- Natural persons appear in the register: publish aggregates + per-contract evidence (`crz evidence <id>` = detail.json + PDF + SHA-256 manifest), not name dumps.
- Reuse credits: register is public; differential exports CC BY 4.0 (attribution: Úrad vlády SR, crz.gov.sk).

## Error contract

Non-zero exits carry `{ok:false, error:{code, message, hint}}` — read `hint` first; it encodes the known failure modes (maintenance windows, Node version, variant retries, mirror bootstrap). `EMPTY_RESULT` from `search`/`fulltext` means *suspicious*, not absent — the LIKE breaks on `&` and spacing; `entity`/`profile` handle that union for you.

## Dev / contributing

```sh
git clone … ~/.opencli/clis/crz    # or edit installed copy; hot-reloads by mtime
ln -sfn "$(npm root -g)/@jackwener" node_modules/@jackwener    # tests only (ESM resolution)
npm test && npm run coverage        # 82 offline tests; utils 100 % lines
npm run fixtures                    # regenerate synthetic fixture universe (no network)
CRZ_LIVE=1 npm test                 # optional live drift tier
```
Never run `npm run capture`-style live recapture into the repo — fixtures must stay synthetic.
