# opencli-crz — Centrálny register zmlúv, from the terminal

[OpenCLI](https://github.com/jackwener/opencli) adapters for the Slovak **Central Register of Contracts** ([crz.gov.sk](https://www.crz.gov.sk)) — ~6M published public-sector contracts. Built for investigative/business reporting: search, aggregate, download, and freeze evidence — all as plain JSON from your shell or agent.

No browser, no API key: public HTML + the official nightly differential files, normalized.

## Setup

Everything (Node 22+ → OpenCLI → this adapter set) installs with **one pasted line**. No admin rights, no sudo, no binaries to unblock.

**macOS / Linux / WSL**
```sh
curl -fsSL https://raw.githubusercontent.com/Yakow13/opencli-crz/main/install.sh | bash
```

**Windows 10/11 (PowerShell)**
```powershell
powershell -c "irm https://raw.githubusercontent.com/Yakow13/opencli-crz/main/install.ps1 | iex"
```

The installer picks Node up via existing nvm → Homebrew → bootstraps nvm user-space itself, installs `@jackwener/opencli` from npm, drops the latest release into `~/.opencli/clis/crz`, then verifies by counting commands and running a live smoke. Re-running it updates in place.

**Manual / agents** (three lines):
```sh
npm install -g @jackwener/opencli           # Node ≥ 20.18 (≥ 22.5 for sync/sql/entity-db)
mkdir -p ~/.opencli/clis/crz && curl -fsSL https://codeload.github.com/Yakow13/opencli-crz/tar.gz/refs/heads/main \
  | tar xz --strip-components=1 -C ~/.opencli/clis/crz
opencli list crz                             # lists the commands → installed ✓
```

Agent operators: read [`AGENTS.md`](AGENTS.md) — install/verify contract, mirror bootstrap, output-envelope rules, privacy doctrine.

**Troubleshooting**

| Symptom | Fix |
|---|---|
| `opencli: command not found` after install | new terminal (PATH), or check `npm prefix -g` is on PATH |
| npm EACCES on global install | installer falls back to user-space nvm — rerun it in a fresh shell |
| `crz sync/sql/entity-db` complain about Node | need Node ≥ 22.5; everything else runs on ≥ 20.18 |
| HTTP 500 / nothing loads on weekends | CRZ does planned maintenance — retry later; installer smoke warns but still succeeds |
| want to uninstall | `rm -rf ~/.opencli/clis/crz` (mirror/cache stay in `~/.opencli/data` + `~/.opencli/cache` — delete if you want zero traces) |

## Commands

| Command | Purpose |
|---|---|
| `crz search <title>` | Structured search: number, supplier/authority (+IČO), price range, dates, resort |
| `crz fulltext <term>` | Free-text across titles, contract subjects and notes |
| `crz recent` / `crz amendments` / `crz terminated` | Latest 24 h / supplemented / cancelled contracts |
| `crz detail <id>` | Full metadata: parties, IČOs, dates, amounts, attachments |
| `crz attachment <id>` | Download the contract PDF |
| `crz evidence <id>` | Freeze contract + PDFs + SHA-256 manifest (publication-grade snapshot) |
| `crz profile <IČO>` | Entity profile: total state spend/earnings, per year, top counterparties |
| `crz entity <IČO>` | **Every** contract where an IČO is a party — mirror-exact alias-bridged union, or live-leg union with `matchedBy` provenance (fixes the §11 recall hole) |
| `crz collect <query>` | Harvest an entire result set to JSONL (paginated, deduped, rate-limited) |
| `crz feed` | RSS with precise publication timestamps |
| `crz export [date]` | Official daily differential ZIP (bulk XML, CC BY 4.0) |
| `crz changes [date]` | Normalized change events from the daily differential (who/what/how-much, incl. supplement deltas) |
| `crz sync [--since …]` | Incremental local SQLite mirror fed by the nightlies (watermark/resume, idempotent) |
| `crz sql "SELECT …"` | Read-only SQL over the mirror — arbitrary joins, zero site load |

```sh
opencli crz search "kúpna zmluva" --rezort "Ministerstvo obrany SR" --min-amount 10000
opencli crz sync --since 2026-01-01                    # local mirror, then:
opencli crz sql "SELECT supplier, COUNT(*) n, SUM(sum_total) eur FROM contracts
                 GROUP BY 1 ORDER BY eur DESC LIMIT 10"
opencli crz profile 45678902 --role supplier           # who does this company sell to?
opencli crz collect "dodatok" --source fulltext --out dodatky.jsonl
opencli crz evidence 99999901 --dir cases             # detail.json + PDF + sha256
```

## Notes

- Output is JSON by default (`-f table|csv|md` available); amounts normalize to numbers, Slovak dates to ISO.
- `search`/`fulltext` return an **envelope** (`{rows, rowCount, hasMore, pageCount, pageWindowMax, usedQuery…}`) so agents never answer from a silent slice; zero-hit party queries auto-retry `&`/spacing variants and report which worked; `--party-ico` unions supplier+authority legs — CRZ leaves supplier IČOs blank at the source, so every single-leg query under-counts.
- Page cache (`~/.opencli/cache/crz`, per-command `--fresh`) keeps agent loops polite; bulk tools throttle themselves — CRZ asks heavy consumers to prefer the nightly diffs.
- Legacy (pre-2011) contracts resolve via the bare `/<id>/` path automatically.
- **Privacy by design:** the repository contains no real register content — fixtures are a deterministic synthetic universe mirroring live structure (see `test/README.md`). What the live tier verifies, it never stores.

## Development & tests

```sh
ln -sfn "$(npm root -g)/@jackwener" node_modules/@jackwener  # dev only: ESM resolution
npm test          # 88 offline tests over 20 synthetic fixtures (test/fixtures)
npm run fixtures  # regenerate the fixture universe (deterministic, offline)
CRZ_LIVE=1 npm test   # + live drift detector
```

`utils.js` is at 100% line coverage; see `test/README.md` for the site-quirk catalogue.

## License

MIT (adapter code). Contract data © Úrad vlády SR — the register is public; differential exports carry CC BY 4.0. The register contains personal data of private counterparties: aggregate, cite per-contract URLs, don't republish bulk name dumps.
