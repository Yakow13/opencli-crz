/**
 * Daily differential export ZIP (official CRZ bulk-feed mechanism).
 * Every night around 02:00 CET CRZ publishes /export/yyyy-mm-dd.zip with XML
 * describing all contract changes of the previous day (including attachment
 * names for direct download). Licensed CC BY 4.0 — see /stahovanie-udajov-z-crz/.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { BASE, fetchBytes } from './utils.js';
import fs from 'node:fs/promises';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function yesterdayIso() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

cli({
    site: 'crz',
    name: 'export',
    description: 'Download CRZ daily differential ZIP (XML with all contract changes of one day)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz export 2026-10-30 --out ./crz.zip',
    args: [
        { name: 'date', positional: true, type: 'string', help: 'Day as yyyy-mm-dd (default: yesterday)' },
        { name: 'out', type: 'string', help: 'Output file path (default: ./crz-<date>.zip)' },
    ],
    func: async (args) => {
        const date = args.date ? String(args.date).trim() : yesterdayIso();
        if (!DATE_RE.test(date)) throw new ArgumentError(`Invalid date "${date}"`, 'Use yyyy-mm-dd, e.g. 2026-10-30.');
        const url = `${BASE}/export/${date}.zip`;
        const bytes = await fetchBytes(url);
        if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            throw new CommandExecutionError(`Response for ${date} is not a ZIP archive (${bytes.length} bytes)`, 'CRZ keeps differential files only for recent days (generated nightly around 02:00).');
        }
        const target = args.out ? String(args.out) : `crz-${date}.zip`;
        await fs.writeFile(target, bytes);
        return {
            date,
            url,
            bytes: bytes.length,
            path: target,
            license: 'CC BY 4.0',
            note: 'Contains a differential XML with metadata of all contract changes for the day, plus attachment names for direct download.',
        };
    },
});
