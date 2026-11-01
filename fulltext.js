/**
 * CRZ full-text search (Fulltextové vyhľadávanie).
 * Unlike `search` (which filters structured fields), this matches the free-text
 * content the authority typed into the contract record: title, subject of
 * performance (predmet plnenia) and notes. Best for hunting names, surnames,
 * project codenames. Returns an envelope with page state (§11 F6).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { BASE, fetchText, parseRows, resolveSearchPath, derivePageState } from './utils.js';

cli({
    site: 'crz',
    name: 'fulltext',
    description: 'Full-text search across CRZ contract titles, subjects and notes',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz fulltext "konzultačné služby" --limit 20',
    args: [
        { name: 'term', positional: true, required: true, type: 'string', help: 'Free-text term(s) to find in contract title/subject/notes' },
        { name: 'page', type: 'int', default: 0, help: 'Result page, 0-based (20 rows per page)' },
        { name: 'limit', type: 'int', default: 20, help: 'Rows to return from the page (1-20)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 10-minute page cache' },
    ],
    columns: ['publishedAt', 'title', 'number', 'amount', 'supplier', 'authority', 'id'],
    func: async (args) => {
        const term = String(args.term ?? '').trim();
        if (!term) throw new ArgumentError('Full-text term must not be empty');
        const page = Number(args.page ?? 0);
        if (!Number.isInteger(page) || page < 0) throw new ArgumentError('page must be a non-negative integer');
        const params = new URLSearchParams({ odoslat: '1', search: term });
        if (page > 0) params.set('page', String(page));
        const path = await resolveSearchPath();
        const html = await fetchText(`${BASE}${path}?${params.toString()}`, { referer: `${BASE}/`, fresh: args.fresh === true });
        const rows = parseRows(html);
        if (!rows.length) {
            throw new EmptyResultError(`CRZ fulltext matched nothing for "${term}"`,
                'Fulltext breaks on "&" and spacing (§11 F5) — rephrase, or use `opencli crz search` / `collect`.');
        }
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 20));
        return { page, rows: rows.slice(0, limit), rowCount: rows.length, ...derivePageState(html, page, rows.length), query: params.toString() };
    },
});
