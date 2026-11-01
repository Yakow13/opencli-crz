/** Supplemented contracts (Doplnené zmluvy, /doplnene-zmluvy/). */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { fetchListPage } from './utils.js';

cli({
    site: 'crz',
    name: 'amendments',
    description: 'List CRZ contracts that were supplemented/amended after publication',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz amendments --page 1',
    args: [
        { name: 'page', type: 'int', default: 0, help: 'Page number, 0-based (20 rows per page)' },
        { name: 'limit', type: 'int', default: 20, help: 'Rows to return from the page (1-20)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 10-minute page cache' },
    ],
    columns: ['publishedAt', 'title', 'number', 'amount', 'supplier', 'authority', 'id'],
    func: async (args) => {
        const page = Number(args.page ?? 0);
        if (!Number.isInteger(page) || page < 0) throw new ArgumentError('page must be a non-negative integer');
        const { rows } = await fetchListPage('/doplnene-zmluvy/', { page, fresh: args.fresh === true });
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 20));
        return rows.slice(0, limit);
    },
});
