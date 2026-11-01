/**
 * `crz entity <IČO>` — the one-call answer to "every contract where this company
 * is a party", built from §11's hard lesson: a single query leg is provably lossy
 * (blank source IČOs under-count; legal-name drift defeats name queries).
 *
 * Modes (auto-selected):
 *  - db   (mirror exists): exact union via the aliases bridge — IČO legs + rows
 *         whose IČO is blank but whose submitted name matches a name observed for
 *         this IČO. Fast, offline, deterministic.
 *  - site (no mirror): live legs — art_ico, art_ico1, then name legs derived from
 *         the party strings seen on the IČO legs, with strict normKey equality
 *         post-filter (the site LIKE is loose and returns strangers, §11 F5).
 *
 * Every row carries matchedBy ('ico' > 'name') and partyRoles — aggregates state
 * their entity key provenance, per the publishability rule (PLAN §10).
 */
import fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { searchQueryParams, harvest, normKey } from './utils.js';
import { openMirror, DEFAULT_DB } from './mirror.js';

const round2 = (n) => Math.round(n * 100) / 100;

function aggregate(rows) {
    const sumByRole = { supplier: 0, authority: 0 };
    const byYear = {};
    for (const r of rows) {
        for (const role of r.partyRoles) {
            if (r.amount != null) sumByRole[role] = round2(sumByRole[role] + r.amount);
        }
        const year = (r.publishedAt || 'unknown').slice(0, 4);
        const y = byYear[year] ?? { contracts: 0, sum: 0 };
        y.contracts += 1;
        if (r.amount != null) y.sum = round2(y.sum + r.amount);
        byYear[year] = y;
    }
    return { sumByRole, byYear };
}

function dbEntity(db, ico, year) {
    const arms = db.prepare(
        `SELECT c.crzid, c.title, c.sum_total AS amount, c.published_at, c.closed_at,
                c.supplier, c.authority, a.role, a.ico AS side_ico,
                CASE WHEN a.ico = ? THEN 'ico' ELSE 'name' END AS matched_by
         FROM aliases a JOIN contracts c ON c.crzid = a.crzid
         WHERE a.ico = ?
            OR a.name_norm IN (SELECT name_norm FROM aliases WHERE ico = ? AND name_norm <> '')`
    ).all(ico, ico, ico).map((r) => ({ ...r }));
    const byId = new Map();
    for (const a of arms) {
        if (year && !(a.published_at || '').startsWith(String(year))) continue;
        const row = byId.get(a.crzid) ?? {
            id: a.crzid, title: a.title, amount: a.amount,
            publishedAt: (a.published_at || '').slice(0, 10) || null,
            closedAt: a.closed_at, supplier: a.supplier, authority: a.authority,
            partyRoles: [], matchedBy: 'name', blankIco: true,
        };
        if (!row.partyRoles.includes(a.role)) row.partyRoles.push(a.role);
        if (a.matched_by === 'ico') { row.matchedBy = 'ico'; }
        if (a.side_ico) row.blankIco = false;
        byId.set(a.crzid, row);
    }
    return [...byId.values()].sort((x, y) => String(x.publishedAt).localeCompare(String(y.publishedAt)));
}

async function siteEntity(args, ico, year) {
    const opts = { maxPages: Math.max(1, Number(args['max-pages'] ?? 3)), delayMs: Number(args['delay-ms'] ?? 1400), fresh: args.fresh === true };
    const legs = [
        ['supplier', await searchQueryParams({ 'supplier-ico': ico }), 'supplier'],
        ['authority', await searchQueryParams({ 'authority-ico': ico }), 'authority'],
    ];
    const byId = new Map();
    const merge = (row, role, matchedBy) => {
        if (year && !(row.publishedAt || '').startsWith(String(year))) return;
        const cur = byId.get(row.id) ?? { ...row, partyRoles: [], matchedBy: 'name' };
        if (!cur.partyRoles.includes(role)) cur.partyRoles.push(role);
        if (matchedBy === 'ico') cur.matchedBy = 'ico';
        byId.set(row.id, cur);
    };
    const namePool = { supplier: new Map(), authority: new Map() }; // normKey → raw representative
    for (const [role, params] of legs) {
        const { rows } = await harvest(params, opts);
        for (const r of rows) {
            merge(r, role, 'ico');
            const party = r[role]; // the entity's own side on this leg
            const norm = normKey(party);
            // §11 F3 shape: party strings carrying embedded address/IČO blobs are NOT useful
            // name-leg queries — keep them out of the pool (the row itself stays via the IČO leg)
            if (norm && norm.length <= 48 && !/ico\d{5,}/.test(norm)) {
                const cur = namePool[role].get(norm);
                if (!cur || party.length < cur.length) namePool[role].set(norm, party);
            }
        }
    }
    // name legs: catch rows whose submitted IČO is blank (§11 F1) — strict equality post-filter
    const used = [];
    let variantBudget = Math.max(1, Number(args['max-variants'] ?? 4));
    for (const role of ['supplier', 'authority']) {
      for (const [norm, raw] of namePool[role]) {
        if (variantBudget-- <= 0) break;
        const params = await searchQueryParams({ [role]: raw });
        const { rows } = await harvest(params, opts);
        used.push(raw);
        for (const r of rows) {
            if (normKey(r[role]) !== norm) continue; // drop loose-LIKE strangers
            merge(r, role, 'name');
        }
      }
    }
    return { rows: [...byId.values()], nameVariantsUsed: used };
}

cli({
    site: 'crz',
    name: 'entity',
    description: 'All CRZ contracts where an IČO is a party — mirror-exact or live-leg union, with matchedBy provenance',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz entity 45678901   # or crz sync first for exact alias-bridged totals',
    args: [
        { name: 'ico', positional: true, required: true, type: 'string', help: 'Entity IČO (5-10 digits)' },
        { name: 'db', type: 'string', help: `Mirror path (default ${DEFAULT_DB}; falls back to site legs when absent)` },
        { name: 'year', type: 'int', help: 'Filter by publication year' },
        { name: 'max-pages', type: 'int', default: 3, help: 'Pages per leg in site mode (20 rows each)' },
        { name: 'max-variants', type: 'int', default: 4, help: 'Name legs to probe in site mode' },
        { name: 'delay-ms', type: 'int', default: 1400, help: 'Site-mode leg politeness delay' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass page cache in site mode' },
    ],
    columns: ['publishedAt', 'title', 'amount', 'supplier', 'authority', 'id'],
    func: async (args) => {
        const ico = String(args.ico ?? '').trim();
        if (!/^\d{5,10}$/.test(ico)) throw new ArgumentError(`Invalid IČO "${ico}"`, 'IČO is a 5-10 digit number.');
        const year = args.year != null ? String(args.year) : null;
        const dbPath = args.db ? String(args.db) : DEFAULT_DB;
        const useDb = fs.existsSync(dbPath);
        let rows, extra = {};
        if (useDb) {
            const db = await openMirror(dbPath);
            try { rows = dbEntity(db, ico, year); } finally { db.close(); }
        } else {
            const site = await siteEntity(args, ico, year);
            rows = site.rows;
            extra = { nameVariantsUsed: site.nameVariantsUsed, hint: 'mirror absent — site legs union (capped). For exact complete totals: `opencli crz sync --since <yyyy-mm-dd>`' };
        }
        if (!rows.length) {
            throw new EmptyResultError(`CRZ found no contracts for IČO ${ico}${year ? ` in ${year}` : ''}`,
                useDb ? 'Verify the IČO; the mirror watermark may not cover the period — crz sync --since …'
                      : 'Names drift and source IČOs are blank in ~33% of rows — run `crz sync` and retry with the mirror (exact), or vary the year.');
        }
        return {
            ico,
            source: useDb ? 'db' : 'site',
            contracts: rows.length,
            blankIcoRows: rows.filter((r) => r.matchedBy === 'name').length,
            ...aggregate(rows),
            rows,
            ...extra,
        };
    },
});
