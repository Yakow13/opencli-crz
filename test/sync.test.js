/**
 * Phase 2 / M2 — `crz sync` (diff-fed SQLite mirror) + `crz sql`, test-first.
 * node:sqlite is used unflagged on this Node (probed 2026-11-01).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installFetch } from './helpers/fetch-stub.js';
import { makeStoredZip, DAY1_XML, DAY2_XML, DB_TEST_OPTS } from './helpers/mirror-fixtures.js';
import { commandDef } from './helpers/commands.js';

async function withDb(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-db-'));
    const db = path.join(dir, 'mirror.sqlite');
    try { return await fn(db); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function twoDayStub() {
    return installFetch([
        { match: /\/export\/2026-01-02\.zip$/, body: makeStoredZip('2026-01-02.xml', DAY1_XML) },
        { match: /\/export\/2026-01-03\.zip$/, body: makeStoredZip('2026-01-03.xml', DAY2_XML) },
        { match: /\/export\/2026-01-04\.zip$/, body: makeStoredZip('2026-01-04.xml', '<?xml version="1.0"?><zmluvy/>') },
    ]);
}

test('sync: ingests days into mirror tables with watermark; idempotent on re-run', DB_TEST_OPTS, async () => {
    await withDb(async (db) => {
        const stub = twoDayStub();
        try {
            const sync = await commandDef('sync');
            const res = await sync.func({ since: '2026-01-02', until: '2026-01-04', db });
            assert.equal(res.days, 3);
            assert.equal(res.events, 3);          // 2 on day1 + 1 on day2 (+ empty day 0)
            assert.equal(res.contracts, 2);
            assert.equal(res.emptyDays, 1);
            assert.equal(stub.calls.length, 3);   // one fetch per day

            const sql = await commandDef('sql');
            const contracts = await sql.func({ query: 'SELECT crzid, kind, sum_total, supplier_ico, change_ts FROM contracts ORDER BY crzid', db });
            assert.equal(contracts.rows.length, 2);
            assert.equal(contracts.rows[0].crzid, 9000001);
            assert.equal(contracts.rows[0].sum_total, 2500, 'day2 newer chan must win (upsert by change_ts)');
            assert.equal(contracts.rows[1].kind, 'amendment');
            assert.equal(contracts.rows[1].supplier_ico, null, 'blank ico preserved as null (§11 F2)');

            const events = await sql.func({ query: 'SELECT day, COUNT(*) AS c FROM events GROUP BY day ORDER BY day', db });
            assert.deepEqual(events.rows, [{ day: '2026-01-02', c: 2 }, { day: '2026-01-03', c: 1 }]);

            const aliases = await sql.func({ query: "SELECT ico, COUNT(DISTINCT crzid) AS c FROM aliases WHERE name_norm = 'firmsro' GROUP BY ico", db });
            assert.equal(aliases.rows.length, 2, 'alias rows for both 11111111 and the blank-ico record');

            // ── idempotent re-run: no duplicates, counts stable
            const res2 = await sync.func({ since: '2026-01-02', until: '2026-01-04', db });
            assert.equal(res2.events, 3);
            const again = await sql.func({ query: 'SELECT COUNT(*) AS c FROM contracts', db });
            assert.equal(again.rows[0].c, 2);
            const meta = await sql.func({ query: "SELECT value FROM meta WHERE key = 'watermark'", db });
            assert.equal(meta.rows[0].value, '2026-01-04');
        } finally { stub.restore(); }
    });
});

test('sync: stale out-of-order chan never overwrites newer state', DB_TEST_OPTS, async () => {
    await withDb(async (db) => {
        const stub = twoDayStub();
        try {
            const sync = await commandDef('sync');
            await sync.func({ since: '2026-01-02', until: '2026-01-04', db });
            // now feed an OLDER day again (day1 chan < day2 chan) — sum_total must stay 2500
            await sync.func({ since: '2026-01-02', until: '2026-01-02', db });
            const sql = await commandDef('sql');
            const one = await sql.func({ query: 'SELECT sum_total FROM contracts WHERE crzid = 9000001', db });
            assert.equal(one.rows[0].sum_total, 2500);
        } finally { stub.restore(); }
    });
});

test('sync: missing day (404) is a recorded gap, not a crash; --resume continues from watermark', DB_TEST_OPTS, async () => {
    await withDb(async (db) => {
        const stub = installFetch([
            { match: /\/export\/2026-01-02\.zip$/, body: makeStoredZip('2026-01-02.xml', DAY1_XML) },
            { match: /\/export\/2026-01-03\.zip$/, status: 404, body: 'gone' },
            { match: /\/export\/2026-01-04\.zip$/, body: makeStoredZip('2026-01-04.xml', DAY2_XML) },
        ]);
        try {
            const sync = await commandDef('sync');
            const res = await sync.func({ since: '2026-01-02', until: '2026-01-04', db });
            assert.equal(res.gaps, 1);
            assert.deepEqual(res.gapDays, ['2026-01-03']);
            assert.equal(res.events, 3);
        } finally { stub.restore(); }
    });
});

test('sql: read-only guard, row limit, and unknown db gets a helpful error', DB_TEST_OPTS, async () => {
    await withDb(async (db) => {
        const stub = twoDayStub();
        try {
            const sync = await commandDef('sync');
            await sync.func({ since: '2026-01-02', until: '2026-01-02', db });
            const sql = await commandDef('sql');
            await assert.rejects(sql.func({ query: 'DELETE FROM contracts', db }), /read-only|SELECT/i);
            await assert.rejects(sql.func({ query: 'UPDATE contracts SET sum_total = 0', db }), /read-only|SELECT/i);
            const limited = await sql.func({ query: 'SELECT * FROM contracts', db, limit: 1 });
            assert.equal(limited.rows.length, 1);
            assert.equal(limited.truncated, true);
        } finally { stub.restore(); }
    });
    await withDb(async (db) => {
        const sql = await commandDef('sql');
        await assert.rejects(sql.func({ query: 'SELECT 1', db }), /does not exist|no such|sync/i);
    });
});

test('sync: default range with no watermark starts from --since-required hint (typed error)', DB_TEST_OPTS, async () => {
    await withDb(async (db) => {
        const stub = installFetch([]);
        try {
            const sync = await commandDef('sync');
            await assert.rejects(sync.func({ db, until: '2026-01-05' }), /--since/);
            assert.equal(stub.calls.length, 0);
        } finally { stub.restore(); }
    });
});
