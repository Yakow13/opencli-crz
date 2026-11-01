/**
 * `crz sql` — read-only query surface of the CRZ mirror (Phase 2/M2).
 * The whole point: arbitrary joins/aggregations over the local mirror with
 * zero site load, safe for an agent's hypothesis loops. Writes are refused.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { openMirror, DEFAULT_DB } from './mirror.js';

const READ_ONLY = /^\s*(SELECT|WITH|PRAGMA)\b/i;

cli({
    site: 'crz',
    name: 'sql',
    description: 'Run a read-only SELECT against the local CRZ mirror database',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz sql "SELECT supplier, COUNT(*) c, SUM(sum_total) s FROM contracts GROUP BY supplier ORDER BY s DESC LIMIT 10"',
    args: [
        { name: 'query', positional: true, required: true, type: 'string', help: 'SELECT/WITH statement (tables: contracts, events, attachments, aliases, meta)' },
        { name: 'db', type: 'string', help: `Mirror path (default ${DEFAULT_DB})` },
        { name: 'limit', type: 'int', default: 500, help: 'Max rows returned (truncated flag when cut)' },
    ],
    func: async (args) => {
        const query = String(args.query ?? '').trim();
        if (!query) throw new ArgumentError('SQL query must not be empty');
        if (!READ_ONLY.test(query)) {
            throw new ArgumentError('crz sql is read-only: SELECT/WITH statements only',
                'The mirror is rebuilt any time with `crz sync` — write nothing, mutate nothing, stay auditable.');
        }
        const dbPath = args.db ? String(args.db) : DEFAULT_DB;
        const db = openMirror(dbPath, { mustExist: true });
        try {
            let rows;
            try {
                // row objects from node:sqlite have null prototype; normalize for consumers
                rows = db.prepare(query).all().map((r) => ({ ...r }));
            } catch (e) {
                throw new CommandExecutionError(`Query failed: ${e.message}`, 'Check table/column names: contracts, events, attachments, aliases, meta');
            }
            const limit = Math.max(1, Number(args.limit ?? 500));
            const truncated = rows.length > limit;
            return { rows: rows.slice(0, limit), count: rows.length, truncated, db: dbPath };
        } finally {
            db.close();
        }
    },
});
