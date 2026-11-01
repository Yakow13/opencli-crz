/**
 * `crz sync` — incremental, idempotent mirror of CRZ via the official nightly
 * differential ZIPs (Phase 2/M2). Cron-safe. Days are fetched in order; a
 * missing day is a recorded gap, never a crash; 5xx aborts cleanly so the
 * watermark never claims more than what was durably ingested.
 */
import fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { BASE, fetchBytes, sleep } from './utils.js';
import { readZip, parseDiffXml } from './diff.js';
import { openMirror, upsertEvent, getMeta, setMeta, DEFAULT_DB } from './mirror.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIRST_SYNC_HINT = 'Bootstrap choice: `crz changes` a wide range costs one small download/day; typical starting points: 5 years back for a beat, or a specific scandal window.';

function assertRange(since, until, maxDays) {
    for (const [label, v] of [['since', since], ['until', until]]) {
        if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
            throw new ArgumentError(`Invalid ${label} "${v}"`, 'Use yyyy-mm-dd.');
        }
    }
    if (since > until) throw new ArgumentError(`since ${since} is after until ${until}`);
    const days = [...dateRange(since, until)];
    if (days.length > maxDays) {
        throw new ArgumentError(`Range covers ${days.length} days; max-days is ${maxDays}`,
            'Run in chunks — or raise --max-days deliberately.');
    }
    return days;
}

function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function* dateRange(from, to) {
    let cur = from;
    while (cur <= to) {
        yield cur;
        cur = addDays(cur, 1);
    }
}

cli({
    site: 'crz',
    name: 'sync',
    description: 'Ingest CRZ daily differential XMLs into the local SQLite mirror (incremental, idempotent)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz sync --since 2025-01-01   # then query with: opencli crz sql "SELECT …"',
    args: [
        { name: 'since', type: 'string', help: 'First day yyyy-mm-dd (default: stored watermark + 1)' },
        { name: 'until', type: 'string', help: 'Last day inclusive (default: yesterday)' },
        { name: 'db', type: 'string', help: `Mirror path (default ${DEFAULT_DB})` },
        { name: 'delay-ms', type: 'int', default: 500, help: 'Politeness delay between daily archives' },
        { name: 'max-days', type: 'int', default: 400, help: 'Safety cap per run (1-2500)' },
    ],
    columns: ['days', 'events', 'contracts', 'emptyDays', 'gaps', 'watermark'],
    func: async (args) => {
        const dbPath = args.db ? String(args.db) : DEFAULT_DB;
        const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
        const until = args.until ? String(args.until) : yesterday;
        let since = args.since ? String(args.since) : null;
        const maxDays = Math.min(Math.max(Number(args['max-days'] ?? 400), 1), 2500);
        const delayMs = Number(args['delay-ms'] ?? 500);

        // Validate before opening: an argument error must not leave an empty mirror
        // behind — `entity` treats any existing DB as the source of truth.
        let days = null;
        if (since) {
            days = assertRange(since, until, maxDays);
        } else if (!fs.existsSync(dbPath)) {
            throw new ArgumentError('First sync needs --since <yyyy-mm-dd>', FIRST_SYNC_HINT);
        }

        const db = await openMirror(dbPath);
        try {
            if (!since) {
                const wm = getMeta(db, 'watermark');
                if (!wm) throw new ArgumentError('First sync needs --since <yyyy-mm-dd>', FIRST_SYNC_HINT);
                since = addDays(wm, 1);
                days = assertRange(since, until, maxDays);
            }

            let events = 0, emptyDays = 0, gaps = 0;
            const gapDays = [];
            const seenContractIds = new Set();
            for (let i = 0; i < days.length; i++) {
                const day = days[i];
                try {
                    const bytes = await fetchBytes(`${BASE}/export/${day}.zip`);
                    let xmlText = '';
                    for (const buf of readZip(bytes).values()) { xmlText = buf.toString('utf8'); break; }
                    const recs = parseDiffXml(xmlText);
                    for (const ev of recs) {
                        events += 1;
                        upsertEvent(db, day, ev); // always upsert — newer chan must win
                        if (ev.crzid !== null && ev.crzid !== undefined) seenContractIds.add(ev.crzid);
                    }
                    if (!recs.length) emptyDays += 1;
                } catch (e) {
                    if (/HTTP 404/.test(e.message)) { gaps += 1; gapDays.push(day); }
                    else throw e; // 5xx/network: abort — watermark stays honest, rerun resumes
                }
                const wmPrev = getMeta(db, 'watermark');
                if (!wmPrev || day > wmPrev) setMeta(db, 'watermark', day);
                if (i + 1 < days.length && delayMs > 0) await sleep(delayMs + Math.random() * 300);
            }
            setMeta(db, 'last_sync_at', new Date().toISOString());
            if (gapDays.length) setMeta(db, 'gaps', JSON.stringify(gapDays));
            return { days: days.length, events, contracts: seenContractIds.size, emptyDays, gaps, gapDays,
                watermark: getMeta(db, 'watermark'), db: dbPath };
        } finally {
            db.close();
        }
    },
});
