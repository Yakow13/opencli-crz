/**
 * `crz changes <date>` — normalized event stream from the official nightly
 * differential ZIP (Phase 2 ingest). This is the sanctioned bulk channel:
 * one small download per day instead of crawling pages, CC BY 4.0.
 * An empty day is SUCCESS with 0 events (§10: valid ZIP containing <zmluvy/>).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import fs from 'node:fs/promises';
import { BASE, fetchBytes } from './utils.js';
import { readZip, parseDiffXml } from './diff.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function yesterdayIso() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

function assertRealDate(date) {
    if (!DATE_RE.test(date)) throw new ArgumentError(`Invalid date "${date}"`, 'Use a real calendar day as yyyy-mm-dd, e.g. 2026-10-30.');
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
        throw new ArgumentError(`Invalid date "${date}"`, 'Not a real calendar day.');
    }
}

cli({
    site: 'crz',
    name: 'changes',
    description: 'Normalized change events from the CRZ daily differential XML (published/amended/terminated)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz changes 2026-10-30 --out events.jsonl',
    args: [
        { name: 'date', positional: true, type: 'string', help: 'Day as yyyy-mm-dd (default: yesterday)' },
        { name: 'out', type: 'string', help: 'Write event rows as JSONL to this path' },
    ],
    columns: ['crzid', 'kind', 'title', 'authority', 'supplier', 'sumTotal', 'changeTs'],
    func: async (args) => {
        const date = args.date ? String(args.date).trim() : yesterdayIso();
        assertRealDate(date);
        const url = `${BASE}/export/${date}.zip`;
        const bytes = await fetchBytes(url);
        let entries;
        try {
            entries = readZip(bytes);
        } catch (e) {
            throw new CommandExecutionError(`Downloaded blob for ${date} is not a ZIP archive: ${e.message}`,
                'CRZ generates differentials nightly ~02:00; unexpected content may mean a maintenance interstitial — retry later.');
        }
        const [name, xmlBuf] = [...entries.entries()][0] ?? [];
        if (!xmlBuf) throw new CommandExecutionError(`No XML entry inside ${url}`);
        const events = parseDiffXml(xmlBuf.toString('utf8'));
        const out = {
            date,
            url,
            archiveEntry: name ?? null,
            bytes: bytes.length,
            events: events.length,
            isEmptyDay: events.length === 0,
            kinds: Object.fromEntries(events.reduce((m, e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1), new Map()).entries()),
            blankSupplierIco: events.filter((e) => e.icoSourceFlag === 'blank').length,
        };
        if (args.out) {
            const body = events.map((e) => JSON.stringify(e)).join('\n');
            await fs.writeFile(String(args.out), body ? body + '\n' : '');
            out.out = String(args.out);
        }
        if (!args.out) out.rows = events; // small days inline; big days go through --out
        return out;
    },
});
