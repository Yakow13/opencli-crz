/**
 * Topic 3: stateful machinery — harvest pagination, profile aggregation,
 * evidence bundling, cache semantics. Phase 2 (sync/sql/flags) will build on
 * exactly these functions, so their contracts are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fixture } from './helpers/fixtures.js';
import { installFetch, paramsOf } from './helpers/fetch-stub.js';
import { rowsHtml, detailHtml, ATT_PDF_BYTES } from './helpers/synth.js';
import { commandDef } from './helpers/commands.js';

/** Serve an array of page bodies keyed by ?page= (clamps at last entry). */
function servePages(bodies) {
    const orig = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
        urls.push(url);
        const page = Number(new URL(url).searchParams.get('page') ?? 0);
        return new Response(bodies[Math.min(page, bodies.length - 1)], { status: 200 });
    };
    return { urls, restore: () => { globalThis.fetch = orig; } };
}

const fullPage = (startId, { hasNext = true, count = 20 } = {}) =>
    rowsHtml(Array.from({ length: count }, (_, i) => ({ id: startId + i })),
        { nextPage: hasNext ? null : 99 });

const endPager = 99; // renders "?page=99" so page+1 lookups succeed generically via row heuristic

// ── harvest ──────────────────────────────────────────────────────────────────
test('harvest: max-pages stops an endless pager; identical pages dedupe', async () => {
    const endless = rowsHtml(Array.from({ length: 20 }, (_, i) => ({ id: 500000 + i })), { nextPage: endPager });
    const stub = servePages([endless]); // same ids every page
    try {
        const { harvest } = await import('../utils.js');
        const r = await harvest(new URLSearchParams({ odoslat: '1' }), { maxPages: 4, delayMs: 0 });
        assert.equal(r.pages, 4);
        assert.equal(r.stop, 'max-pages');
        assert.equal(r.rows.length, 20, 'repeated ids across pages must dedupe');
    } finally { stub.restore(); }
});

test('harvest: row-cap triggers mid-page-chain, page param starts at 1 on request 2', async () => {
    const stub = servePages([
        rowsHtml(Array.from({ length: 20 }, (_, i) => ({ id: 600001 + i })), { nextPage: endPager }),
        rowsHtml(Array.from({ length: 20 }, (_, i) => ({ id: 600101 + i })), { nextPage: endPager }),
    ]);
    try {
        const { harvest } = await import('../utils.js');
        const r = await harvest(new URLSearchParams({ odoslat: '1' }), { maxPages: 10, delayMs: 0, capRows: 25 });
        assert.equal(r.pages, 2);
        assert.equal(r.stop, 'row-cap');
        assert.equal(r.rows.length, 40); // cap checked after whole pages, 20-row granularity
        assert.ok(!stub.urls[0].includes('page='), 'page 0 omits the param');
        assert.ok(stub.urls[1].includes('page=1'));
    } finally { stub.restore(); }
});

test('harvest: short final page ends the walk', async () => {
    const stub = servePages([fullPage(700001), fullPage(710001, { count: 3 })]);
    try {
        const { harvest } = await import('../utils.js');
        const r = await harvest(new URLSearchParams({ odoslat: '1' }), { maxPages: 9, delayMs: 0 });
        assert.equal(r.pages, 2);
        assert.equal(r.stop, 'last-page');
        assert.equal(r.rows.length, 23);
    } finally { stub.restore(); }
});

test('harvest: real fixtures chain into 40 unique rows', async () => {
    const stub = installFetch([
        { match: /page=1$/, file: 'search-kupna-page1.html' },
        { match: /centralny-register-zmluv/, file: 'search-kupna.html' },
    ]);
    try {
        const { harvest } = await import('../utils.js');
        const r = await harvest(new URLSearchParams({ odoslat: '1', art_predmet: 'kúpna' }), { maxPages: 2, delayMs: 0 });
        assert.equal(r.rows.length, 40);
        assert.equal(new Set(r.rows.map((x) => x.id)).size, 40);
        assert.equal(r.stop, 'max-pages');
    } finally { stub.restore(); }
});

// ── collect: contract it promises over harvest ──────────────────────────────
test('collect: writes JSONL + summary; fulltext source sends search=', async () => {
    const stub = installFetch([
        { match: /centralny-register-zmluv.*page=1/, file: 'search-kupna-page1.html' },
        { match: /centralny-register-zmluv/, file: 'search-kupna.html' },
    ]);
    const out = `${import.meta.dirname}/.tmp-collect.jsonl`;
    try {
        const def = await commandDef('collect');
        const res = await def.func({ query: 'kúpna', source: 'search', 'max-pages': 2, 'delay-ms': 0, out });
        assert.equal(res.records, 40);
        const lines = (await fs.readFile(out, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(lines.length, 40);
        assert.ok(lines.every((l) => l.url.includes(`/zmluva/${l.id}/`)));

        await def.func({ query: 'festival koncert', source: 'fulltext', 'max-pages': 1, 'delay-ms': 0, out });
        assert.equal(paramsOf(stub.lastUrl()).search, 'festival koncert');
        assert.ok(!('art_predmet' in paramsOf(stub.lastUrl())));
    } finally {
        stub.restore();
        await fs.rm(out, { force: true });
    }
});

test('collect: arg validation rejects before any request', async () => {
    const stub = installFetch([]);
    try {
        const def = await commandDef('collect');
        await assert.rejects(def.func({ query: 'x', 'max-pages': 0 }), /max-pages/);
        assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
});

test('collect: "-" mode streams JSONL to stdout with null path', async () => {
    const stub = installFetch([{ match: /centralny-register-zmluv/, file: 'search-kupna.html' }]);
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
        const def = await commandDef('collect');
        const res = await def.func({ query: 'kúpna', 'max-pages': 1, 'delay-ms': 0, out: '-' });
        assert.equal(res.path, null);
        assert.equal(res.records, 20);
    } finally {
        process.stdout.write = origWrite;
        stub.restore();
    }
    const lines = chunks.join('').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 20);
});

// ── profile ──────────────────────────────────────────────────────────────────
test('profile: totals exclude unpriced rows but count them; years + variants kept', async () => {
    const p1 = rowsHtml([
        { id: 400001, amount: '1 000,00&nbsp;&euro;', sup: 'ACME s.r.o.', auth: 'MV SR', pub: '1. Január 2024' },
        { id: 400002, amount: '', sup: 'ACME s.r.o.', auth: 'MV SR', pub: '15. Februára 2024' },
        { id: 400003, amount: '500,00&nbsp;&euro;', sup: 'ACME, s.r.o.', auth: 'ÚVO SR', pub: '3. marca 2025' },
    ]);
    const stub = installFetch([{ match: /art_ico=11111111/, body: p1 }]);
    try {
        const def = await commandDef('profile');
        const res = await def.func({ ico: '11111111', role: 'supplier', 'max-pages': 1, 'delay-ms': 0 });
        const s = res.supplier;
        assert.equal(s.contracts, 3);
        assert.equal(s.pricedContracts, 2);
        assert.equal(s.totalAmount, 1500);
        assert.deepEqual(s.byYear['2024'], { contracts: 2, sum: 1000 }); // unpriced row counted, not summed
        assert.deepEqual(s.namesObserved.sort(), ['ACME s.r.o.', 'ACME, s.r.o.']); // variants surfaced, never merged
        assert.equal(s.topCounterparties.length, 2);
        assert.deepEqual(s.topCounterparties[0], { name: 'MV SR', contracts: 1, sum: 1000 }); // priced rows only
    } finally { stub.restore(); }
});

test('profile: invalid IČO never reaches the network', async () => {
    const stub = installFetch([]);
    try {
        const def = await commandDef('profile');
        await assert.rejects(def.func({ ico: '1234' }), /Invalid IČO/);
        assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
});

test('profile: role=both queries art_ico AND art_ico1; empty result is typed', async () => {
    const sup = rowsHtml([{ id: 800001, sup: 'X', auth: 'Y', amount: '1,00&nbsp;&euro;' }]);
    const auth = rowsHtml([{ id: 800101, sup: 'Z', auth: 'W', amount: '' }, { id: 800102, sup: 'Z', auth: 'W' }]);
    const stub = installFetch([
        { match: /art_ico1=33333333/, body: auth },
        { match: /art_ico=33333333/, body: sup },
    ]);
    try {
        const def = await commandDef('profile');
        const res = await def.func({ ico: '33333333', role: 'both', 'max-pages': 1, 'delay-ms': 0 });
        assert.equal(res.supplier.contracts, 1);
        assert.equal(res.authority.contracts, 2);
        assert.ok(res.sample.some((s) => s.role === 'supplier') && res.sample.some((s) => s.role === 'authority'));
    } finally { stub.restore(); }

    const empty = installFetch([{ match: /art_ico/, body: rowsHtml([]) }]);
    try {
        const def = await commandDef('profile');
        await assert.rejects(def.func({ ico: '99999999', role: 'both', 'max-pages': 1, 'delay-ms': 0 }),
            /No CRZ contracts reference IČO 99999999/);
    } finally { empty.restore(); }
});

// ── evidence ─────────────────────────────────────────────────────────────────
test('evidence: manifest sha256 matches bytes; no-files metadata mode', async () => {
    const stub = installFetch([
        { match: /\/zmluva\/99999901\/$/, file: 'detail-basic.html' },
        { match: /\/data\/att\//, body: ATT_PDF_BYTES },
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-ev-'));
    try {
        const def = await commandDef('evidence');
        const res = await def.func({ id: '99999901', dir });
        assert.match(res.folder, /99999901-kupna-zmluva-vzorka-vzorkova$/);
        const manifest = JSON.parse(await fs.readFile(res.manifest, 'utf8'));
        assert.equal(manifest.contractId, 99999901);
        assert.ok(manifest.fetchedAt);
        const pdf = await fs.readFile(path.join(res.folder, manifest.files[0].file));
        assert.equal(manifest.files[0].sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
        assert.equal(pdf[0], 0x25); // %PDF
        assert.equal(res.bytes, ATT_PDF_BYTES.length);

        const meta = await def.func({ id: '99999901', dir, 'no-files': true });
        assert.equal(meta.attachments, 0);
    } finally {
        stub.restore();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('evidence: legacy bare-path contract bundles via 404 fallback', async () => {
    const stub = installFetch([
        { match: /\/zmluva\/9900047\/$/, status: 404, body: 'x' },
        { match: /^https:\/\/www\.crz\.gov\.sk\/9900047\/$/, body: detailHtml({
            pairs: [['ID zmluvy', '9900047'], ['Názov zmluvy', 'Legacy nájom']],
            atts: [{ url: '/data/att/5.pdf', name: 'Zmluva', ext: '.pdf', size: '1 kB' }],
        }) },
        { match: /\/data\/att\//, body: ATT_PDF_BYTES },
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-ev2-'));
    try {
        const def = await commandDef('evidence');
        const res = await def.func({ id: '9900047', dir });
        assert.equal(res.attachments, 1);
        assert.match(res.folder, /9900047-legacy-najom$/);
    } finally {
        stub.restore();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

// ── cache layer (isolated child process: fresh module + sandboxed HOME) ────
test('cache: full lifecycle (ttl hit, fresh, expiry, corrupt, kill-switch) in child process', async (t) => {
    const { spawnSync } = await import('node:child_process');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-home-'));
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'helpers', 'isolated-probe.mjs'), 'cache'], {
        env: { ...process.env, HOME: home, OPENCLI_CRZ_CACHE: '' },
        encoding: 'utf8',
    });
    await fs.rm(home, { recursive: true, force: true });
    assert.match(r.stdout, /PROBE-OK cache/, `${r.stdout}\n${r.stderr}`);
});
