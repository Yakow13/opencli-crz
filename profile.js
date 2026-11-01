/**
 * Entity profile: everything CRZ shows about one IČO (company or authority),
 * aggregated — totals, yearly series, top counterparties. Answers
 * "who does this company sell to the state, how much, since when?"
 * in one agent call. Built on top of paginated search harvesting.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { harvest, searchQueryParams } from './utils.js';

function round2(n) {
    return Math.round(n * 100) / 100;
}

function aggregate(rows, role) {
    const counterKey = role === 'supplier' ? 'authority' : 'supplier';
    const totals = new Map();
    const byYear = new Map();
    let sum = 0;
    let known = 0;
    const names = new Set();
    for (const r of rows) {
        const side = role === 'supplier' ? r.supplier : r.authority;
        if (side) names.add(side.replace(/\s+/g, ' ').trim());
        if (r.amount != null) { sum += r.amount; known += 1; }
        const year = (r.publishedAt || 'unknown').slice(0, 4);
        const y = byYear.get(year) ?? { contracts: 0, sum: 0 };
        y.contracts += 1;
        if (r.amount != null) y.sum += r.amount;
        byYear.set(year, y);
        if (r.amount != null) {
            const c = totals.get(r[counterKey]) ?? { name: r[counterKey], contracts: 0, sum: 0 };
            c.contracts += 1;
            c.sum += r.amount;
            totals.set(r[counterKey], c);
        }
    }
    const top = [...totals.values()]
        .map((t) => ({ ...t, sum: round2(t.sum) }))
        .sort((a, b) => b.sum - a.sum)
        .slice(0, 10);
    const years = Object.fromEntries([...byYear.entries()]
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([y, v]) => [y, { contracts: v.contracts, sum: round2(v.sum) }]));
    return {
        contracts: rows.length,
        pricedContracts: known,
        totalAmount: round2(sum),
        namesObserved: [...names],
        byYear: years,
        topCounterparties: top,
    };
}

cli({
    site: 'crz',
    name: 'profile',
    description: 'Aggregate a CRZ entity profile by IČO: spend, years, top counterparties',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz profile 12345678 --role supplier',
    args: [
        { name: 'ico', positional: true, required: true, type: 'string', help: 'Entity IČO (9 digits typical)' },
        { name: 'role', type: 'string', choices: ['supplier', 'authority', 'both'], default: 'both', help: 'supplier = sells to the state, authority = buys, both = union' },
        { name: 'max-pages', type: 'int', default: 15, help: 'Pages per role query (1-500, 20 rows each)' },
        { name: 'delay-ms', type: 'int', default: 1400, help: 'Delay between page requests (ms)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local page cache' },
    ],
    func: async (args) => {
        const ico = String(args.ico ?? '').trim();
        if (!/^\d{5,10}$/.test(ico)) throw new ArgumentError(`Invalid IČO "${ico}"`, 'IČO is a 5-10 digit number, e.g. 45678902.');
        const maxPages = Number(args['max-pages'] ?? 15);
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw new ArgumentError('max-pages must be 1-500');
        const delayMs = Number(args['delay-ms'] ?? 1400);
        const roles = args.role === 'both' ? ['supplier', 'authority'] : [args.role];

        const out = { ico, role: args.role ?? 'both' };
        const all = [];
        for (const role of roles) {
            const filterArgs = role === 'supplier'
                ? { 'supplier-ico': ico }
                : { 'authority-ico': ico };
            const params = await searchQueryParams(filterArgs);
            const { rows, pages, stop } = await harvest(params, { maxPages, delayMs, fresh: args.fresh === true });
            if (role === 'supplier') out.supplier = { contracts: rows.length, pages, stop, ...(rows.length ? aggregate(rows, 'supplier') : {}) };
            else out.authority = { contracts: rows.length, pages, stop, ...(rows.length ? aggregate(rows, 'authority') : {}) };
            all.push(...rows.map((r) => ({ ...r, role })));
        }
        if (!all.length) {
            throw new EmptyResultError(`No CRZ contracts reference IČO ${ico}`, 'Check the IČO; suppliers without records appear under name variants instead.');
        }
        out.sample = all.slice(0, 5).map((r) => ({ id: r.id, publishedAt: r.publishedAt, title: r.title, amount: r.amount, role: r.role }));
        return out;
    },
});
