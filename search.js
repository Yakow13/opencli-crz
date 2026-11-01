/**
 * CRZ extended contract search (Centrálny register zmlúv, Slovakia).
 *
 * Wraps the public search form at /2171273-sk/centralny-register-zmluv/
 * (path auto-discovered from the filter form on /zmluvy/). Server returns
 * exactly 20 rows per page; `page` is 0-based like the site's ?page= param.
 *
 * Returns an ENVELOPE, not a bare slice (§11 F6): rows are silent-slice-able and
 * the site's LIKE is lossy in both directions (F1/F5), so the CLI must expose
 * page state, used query variants, post-filters and matchedBy provenance.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { BASE, fetchText, parseRows, searchQueryParams, resolveSearchPath,
    partyVariants, normKey, derivePageState } from './utils.js';

const EMPTY_HINT = 'Zero hits often mean a false negative, not absence: the site LIKE breaks '
    + 'on "&" and spacing variants (retry a glued name), or try `opencli crz fulltext`, '
    + 'or cast wider with `opencli crz collect`. For entities, prefer --party-ico (unions both roles).';

async function fetchLeg(path, params, page, fresh) {
    const qs = new URLSearchParams(params);
    if (page > 0) qs.set('page', String(page));
    const html = await fetchText(`${BASE}${path}?${qs.toString()}`, { referer: `${BASE}/zmluvy/`, fresh });
    return { html, rows: parseRows(html), query: qs.toString() };
}

function baseEnvelope(leg, page) {
    const state = derivePageState(leg.html, page, leg.pageRows ?? leg.rows.length);
    return {
        page,
        rows: leg.rows,
        rowCount: leg.rows.length,
        ...state,
        pageCount: state.pageCount,
        query: leg.query,
    };
}

cli({
    site: 'crz',
    name: 'search',
    description: 'Search published public-sector contracts in the Slovak Central Register of Contracts (CRZ)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz search "kúpna zmluva" --authority "Ministerstvo vnútra" --min-amount 1000',
    args: [
        { name: 'query', positional: true, type: 'string', help: 'Contract title text (Názov zmluvy)' },
        { name: 'number', type: 'string', help: 'Contract number (Číslo zmluvy) — exact post-filter; site matches substrings' },
        { name: 'number-contains', type: 'boolean', default: false, help: 'Keep the site substring behavior for --number' },
        { name: 'supplier', type: 'string', help: 'Supplier name (Dodávateľ)' },
        { name: 'supplier-ico', type: 'string', help: 'Supplier IČO (registration number)' },
        { name: 'authority', type: 'string', help: 'Contracting authority name (Objednávateľ)' },
        { name: 'authority-ico', type: 'string', help: 'Contracting authority IČO' },
        { name: 'party-ico', type: 'string', help: 'IČO as EITHER supplier or authority — unions both legs, tags partyRoles (§11 F1)' },
        { name: 'exact-party', type: 'string', help: 'Post-filter rows whose party name contains this exact (normalized) name' },
        { name: 'min-amount', type: 'number', help: 'Min total price in € incl. VAT' },
        { name: 'max-amount', type: 'number', help: 'Max total price in € incl. VAT' },
        { name: 'published-from', type: 'string', help: 'Published on/after (yyyy-mm-dd or dd.mm.yyyy)' },
        { name: 'published-to', type: 'string', help: 'Published on/before (yyyy-mm-dd or dd.mm.yyyy)' },
        { name: 'rezort', type: 'string', help: 'Institution/resort label or numeric id (e.g. "Ministerstvo fiktívne SR")' },
        { name: 'page', type: 'int', default: 0, help: 'Result page, 0-based (20 rows per page)' },
        { name: 'limit', type: 'int', default: 20, help: 'Rows to return from the page (1-20, per leg for --party-ico)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 10-minute page cache' },
    ],
    columns: ['publishedAt', 'title', 'number', 'amount', 'supplier', 'authority', 'id'],
    func: async (args) => {
        const page = Number(args.page ?? 0);
        if (!Number.isInteger(page) || page < 0) throw new ArgumentError('page must be a non-negative integer');
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 20));
        const fresh = args.fresh === true;
        const path = await resolveSearchPath();

        // ── F1: entity union over both role legs — each leg alone is provably lossy
        if (args['party-ico']) {
            const ico = String(args['party-ico']).trim();
            if (!/^\d{5,10}$/.test(ico)) throw new ArgumentError(`Invalid party-ico "${ico}"`, 'IČO is a 5-10 digit number.');
            const base = await searchQueryParams({ ...args, supplier: undefined, authority: undefined });
            const legs = {};
            for (const [role, param] of [['supplier', 'art_ico'], ['authority', 'art_ico1']]) {
                const p = new URLSearchParams(base);
                p.set(param, ico);
                legs[role] = await fetchLeg(path, p, page, fresh);
            }
            const byId = new Map();
            for (const role of ['supplier', 'authority']) {
                for (const row of legs[role].rows) {
                    const merged = byId.get(row.id) ?? { ...row, partyRoles: [] };
                    if (!merged.partyRoles.includes(role)) merged.partyRoles.push(role);
                    byId.set(row.id, merged);
                }
            }
            const rows = [...byId.values()];
            if (!rows.length) throw new EmptyResultError(`CRZ references no contracts under IČO ${ico}`, EMPTY_HINT);
            const applied = postFilters(args, rows);
            const hasMore = ['supplier', 'authority'].some((r) => derivePageState(legs[r].html, page, legs[r].rows.length).hasMore);
            return {
                rows: applied.rows.slice(0, limit),
                rowCount: applied.rows.length,
                page,
                hasMore,
                pageCount: null,
                query: `party-ico=${ico}`,
                matchedBy: 'ico-union',
                legs: Object.fromEntries(['supplier', 'authority'].map((r) =>
                    [r, { rowCount: legs[r].rows.length, hasMore: derivePageState(legs[r].html, page, legs[r].rows.length).hasMore }])),
                ...applied.meta,
            };
        }

        // ── standard single-leg search with F5 variant retry on false-negative
        const params = await searchQueryParams(args);
        let leg = await fetchLeg(path, params, page, fresh);
        leg.pageRows = leg.rows.length;
        let usedQuery;
        if (!leg.rows.length && (args.supplier || args.authority)) {
            const paramKey = args.supplier ? 'art_zs2' : 'art_zs1';
            const original = String(args.supplier || args.authority);
            const variants = partyVariants(original);
            const attempted = [original];
            for (const v of variants.slice(1)) {
                attempted.push(v);
                const p2 = new URLSearchParams(params);
                p2.set(paramKey, v);
                leg = await fetchLeg(path, p2, page, fresh);
                leg.pageRows = leg.rows.length;
                if (leg.rows.length) { usedQuery = { attempted, used: v }; break; }
            }
            if (!usedQuery) usedQuery = { attempted, used: original };
        }
        if (!leg.rows.length) throw new EmptyResultError('CRZ search matched nothing', EMPTY_HINT);

        const applied = postFilters(args, leg.rows);
        leg.rows = applied.rows;
        const envelope = baseEnvelope(leg, page);
        envelope.rows = envelope.rows.slice(0, limit);
        if (usedQuery) envelope.usedQuery = usedQuery;
        if (applied.meta.postFiltered) envelope.postFiltered = applied.meta.postFiltered;
        return envelope;
    },
});

/** F7 (substring-number) and tokenized-stranger (F5) client-side corrections. */
function postFilters(args, rows) {
    let out = rows;
    const names = [];
    if (args['exact-party']) {
        const needle = normKey(args['exact-party']);
        const field = args.supplier ? 'supplier' : args.authority ? 'authority' : null;
        out = field
            ? out.filter((r) => normKey(r[field]).includes(needle))
            : out.filter((r) => normKey(r.supplier).includes(needle) || normKey(r.authority).includes(needle));
        names.push('exact-party');
    }
    if (args.number && !args['number-contains']) {
        const needle = normKey(args.number);
        out = out.filter((r) => normKey(r.number) === needle);
        names.push('exact-number');
    }
    return { rows: out, meta: names.length ? { postFiltered: names.join('+') } : {} };
}
