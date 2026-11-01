/**
 * Harvest a full CRZ result set into JSONL for offline analysis.
 * Paginates with a polite delay, dedupes by contract id, stops when the
 * pager runs out or --max-pages/--cap hit. One command instead of an agent
 * loop, and it leaves a timestamped artifact behind.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harvest, searchQueryParams } from './utils.js';

const FILTER_ARGS = [
    { name: 'source', type: 'string', choices: ['search', 'fulltext'], default: 'search', help: 'Structured-field search or free-text search' },
    { name: 'number', type: 'string', help: 'Contract number (search only)' },
    { name: 'supplier', type: 'string', help: 'Supplier name (search only)' },
    { name: 'supplier-ico', type: 'string', help: 'Supplier IČO (search only)' },
    { name: 'authority', type: 'string', help: 'Contracting authority name (search only)' },
    { name: 'authority-ico', type: 'string', help: 'Contracting authority IČO (search only)' },
    { name: 'min-amount', type: 'number', help: 'Min total price in € incl. VAT (search only)' },
    { name: 'max-amount', type: 'number', help: 'Max total price in € incl. VAT (search only)' },
    { name: 'published-from', type: 'string', help: 'Published on/after (yyyy-mm-dd, search only)' },
    { name: 'published-to', type: 'string', help: 'Published on/before (yyyy-mm-dd, search only)' },
    { name: 'rezort', type: 'string', help: 'Institution/resort label or id (search only)' },
    { name: 'max-pages', type: 'int', default: 25, help: 'Hard stop on pages fetched (1-500)' },
    { name: 'cap', type: 'int', default: 5000, help: 'Hard stop on records collected' },
    { name: 'delay-ms', type: 'int', default: 1400, help: 'Delay between page requests (ms)' },
    { name: 'out', type: 'string', help: 'Output JSONL path; "-" prints lines to stdout without saving' },
    { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local page cache' },
];

cli({
    site: 'crz',
    name: 'collect',
    description: 'Collect every CRZ search/fulltext hit into a JSONL file (paginated, deduped, rate-limited)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz collect "dodatok" --source fulltext --published-from 2024-01-01 --out dodoky.jsonl',
    args: [
        { name: 'query', positional: true, type: 'string', help: 'Title text (source=search) or free-text term (source=fulltext)' },
        ...FILTER_ARGS,
    ],
    func: async (args) => {
        const maxPages = Number(args['max-pages'] ?? 25);
        if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
            throw new ArgumentError('max-pages must be an integer between 1 and 500');
        }
        const fulltext = args.source === 'fulltext';
        const params = await searchQueryParams(args, { fulltext });
        const { rows, pages, stop } = await harvest(params, {
            maxPages,
            delayMs: Number(args['delay-ms'] ?? 1400),
            capRows: Number(args.cap ?? 5000),
            fresh: args.fresh === true,
        });
        if (!rows.length) throw new EmptyResultError('Search matched nothing', 'Broaden the query, or check exact spelling/IČO.');

        if (args.out === '-') {
            process.stdout.write(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
            return { records: rows.length, pages, stop, path: null };
        }
        const target = args.out
            ? String(args.out)
            : `crz-collect-${crypto.createHash('sha1').update(params.toString()).digest('hex').slice(0, 10)}.jsonl`;
        await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
        await fs.writeFile(target, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        return {
            path: target,
            records: rows.length,
            pages,
            stop,
            source: args.source ?? 'search',
            query: params.toString(),
        };
    },
});
