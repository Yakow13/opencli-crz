/**
 * Topic 2: request contract — the exact outgoing URLs each command builds.
 * This is the seam that breaks silently on refactors (kebab-args bug class).
 * Commands run their real production path with globalThis.fetch stubbed to
 * recorded fixtures; we assert on paramsOf(stub.lastUrl()) — not internals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers/fixtures.js';
import { installFetch, paramsOf } from './helpers/fetch-stub.js';
import { rowsHtml, detailHtml, ATT_PDF_BYTES } from './helpers/synth.js';
import { commandDef } from './helpers/commands.js';
import { BASE, matchResort } from '../utils.js';

const FORM = { match: /\/zmluvy\/$/, file: 'form-zmluvy.html' };
const RESULTS = { match: /centralny-register-zmluv/, file: 'search-kupna.html' };

// ── search: complete filter mapping golden ──────────────────────────────────
test('search: every arg maps to its exact site parameter', async () => {
    const stub = installFetch([FORM, RESULTS]);
    try {
        const def = await commandDef('search');
        await def.func({
            query: 'stavebné práce', number: '5/2026', supplier: 'ACME a.s.', 'supplier-ico': '11111111',
            authority: 'Obec Kde', 'authority-ico': '22222222', 'min-amount': 10, 'max-amount': 9999.99,
            'published-from': '2026-01-31', 'published-to': '01.02.2026', rezort: '114495', page: 2, limit: 3,
        });
        assert.deepEqual(paramsOf(stub.lastUrl()), {
            odoslat: '1', art_predmet: 'stavebné práce', nazov: '5/2026', art_zs2: 'ACME a.s.',
            art_ico: '11111111', art_zs1: 'Obec Kde', art_ico1: '22222222',
            art_suma_spolu_od: '10', art_suma_spolu_do: '9999.99',
            art_datum_zverejnene_od: '31.01.2026', art_datum_zverejnene_do: '01.02.2026',
            art_rezort: '114495', page: '2',
        });
    } finally { stub.restore(); }
});

test('search: bad date surfaces as ARGUMENT, not a site request', async () => {
    const stub = installFetch([FORM, RESULTS]);
    try {
        const def = await commandDef('search');
        await assert.rejects(def.func({ 'published-from': '2026-13-99' }), /published-from/);
        assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
});

// ── fulltext ─────────────────────────────────────────────────────────────────
test('fulltext: uses search= param, never the structured fields', async () => {
    const stub = installFetch([FORM, { match: /centralny-register-zmluv/, file: 'fulltext-koncert.html' }]);
    try {
        const def = await commandDef('fulltext');
        const env = await def.func({ term: 'festival koncert', page: 1, limit: 20 });
        assert.equal(env.rows.length, 20);
        assert.equal(env.page, 1);
        const params = paramsOf(stub.lastUrl());
        assert.equal(params.search, 'festival koncert');
        assert.ok(!('art_predmet' in params) && !('nazov' in params));
        assert.equal(params.page, '1');
        await assert.rejects(def.func({ term: '  ' }), /not be empty/);
    } finally { stub.restore(); }
});

// ── list pages ───────────────────────────────────────────────────────────────
test('recent: sort=price-desc adds order=22; page joins with & when query exists', async () => {
    const stub = installFetch([{ match: /zmluvy\/\?order=22&page=1/, file: 'list-recent-order.html' }]);
    try {
        const def = await commandDef('recent');
        const rows = await def.func({ sort: 'price-desc', page: 1 });
        assert.equal(rows.length, 20);
        assert.ok(stub.lastUrl().endsWith('/zmluvy/?order=22&page=1'));
    } finally { stub.restore(); }
});

test('amendments/terminated: page appends to clean path, empty page errors typed', async () => {
    const stub = installFetch([
        { match: /doplnene-zmluvy\/\?page=1$/, file: 'list-amendments.html' },
        { match: /zrusene-zmluvy/, body: '<html><body>prázdno</body></html>' },
    ]);
    try {
        const a = await commandDef('amendments');
        assert.equal((await a.func({ page: 1 })).length, 20);
        const t = await commandDef('terminated');
        await assert.rejects(t.func({}), /No contracts listed/);
    } finally { stub.restore(); }
});

// ── detail + legacy fallback ────────────────────────────────────────────────
test('detail: legacy id falls back from 404 /zmluva/<id>/ to /<id>/', async () => {
    const stub = installFetch([
        { match: /\/zmluva\/9900047\/$/, status: 404, body: 'not found' },
        { match: new RegExp(`^${BASE}/9900047/$`), file: 'detail-basic.html' },
    ]);
    try {
        const def = await commandDef('detail');
        const d = await def.func({ id: '9900047' });
        assert.equal(stub.calls.length, 2);
        assert.equal(d.attachments[0].url, 'https://www.crz.gov.sk/data/att/99000001.pdf');
    } finally { stub.restore(); }
});

test('detail: both HTTP 404s propagate, non-404 error does not retry', async () => {
    const stub = installFetch([{ match: /\/zmluva\/999999999\/$/, status: 404, body: 'x' },
        { match: new RegExp(`^${BASE}/999999999/$`), status: 404, body: 'x' }]);
    try {
        const def = await commandDef('detail');
        await assert.rejects(def.func({ id: '999999999' }), /HTTP 404/);
        assert.equal(stub.calls.length, 2); // canonical then legacy, then give up
    } finally { stub.restore(); }
});

// ── resolveSearchPath discovery + fallback ──────────────────────────────────
test('resolveSearchPath: falls back to constant when form markup is gone (child process)', async () => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'helpers', 'isolated-probe.mjs'), 'fallback'], { encoding: 'utf8' });
    assert.match(r.stdout, /PROBE-OK fallback/, `${r.stdout}\n${r.stderr}`);
});

// ── resort resolution ───────────────────────────────────────────────────────
test('matchResort: numeric passthrough costs zero requests; name resolves via options', async () => {
    assert.equal(await matchResort('114495'), '114495');
    const stub = installFetch([FORM]);
    try {
        assert.equal(await matchResort('Ministerstvo fiktívne SR'), '114495');  // exact label
        assert.equal(await matchResort('ministerstvo fikt'), '114495');         // partial + diacritic-insensitive
        await assert.rejects(matchResort('ministerstvo'), /Ambiguous resort/); // many ministries match
        await assert.rejects(matchResort('KFC Bratislava'), /Unknown resort/);
    } finally { stub.restore(); }
});

// ── attachment ───────────────────────────────────────────────────────────────
test('attachment: index bounds, --name filter, out path, typed empties', async () => {
    const fs = await import('node:fs/promises');
    const stub = installFetch([
        { match: /\/zmluva\/99999901\/$/, file: 'detail-basic.html' },
        { match: /\/data\/att\//, body: ATT_PDF_BYTES },
    ]);
    const out = `${import.meta.dirname}/.tmp-att.pdf`;
    try {
        const def = await commandDef('attachment');
        const res = await def.func({ id: '99999901', index: 0, out });
        assert.equal(res.bytes, ATT_PDF_BYTES.length);
        assert.equal(res.ext, 'pdf');
        assert.equal(res.name, 'Kúpna zmluva (Vzorka, Vzorková)');
        await assert.rejects(def.func({ id: '99999901', index: 5 }), /out of range/);
        await assert.rejects(def.func({ id: '99999901', name: 'neexistuje' }), /No attachment matching/);
    } finally {
        stub.restore();
        await fs.rm(out, { force: true });
    }
});

test('attachment: --name selects the right variant; --out directory appends generated name', async () => {
    const stub = installFetch([
        { match: /\/zmluva\/600600\/$/, body: detailHtml({
            pairs: [['ID zmluvy', '600600'], ['Názov zmluvy', 'Dvojprílohová']],
            atts: [
                { url: '/data/att/10.pdf', name: 'Hlavná zmluva', ext: '.pdf', size: '1 kB' },
                { url: '/data/att/11.zip', name: 'Prílohy zmluvy', ext: '.zip', size: '2 kB' },
            ],
        }) },
        { match: /\/data\/att\/11\.zip/, body: ATT_PDF_BYTES },
    ]);
    const dir = await (await import('node:fs/promises')).mkdtemp(`${os.tmpdir()}/crz-att-`);
    try {
        const def = await commandDef('attachment');
        const res = await def.func({ id: '600600', name: 'prílohy', out: `${dir}/` });
        assert.equal(res.index, 1);
        assert.equal(res.ext, 'zip');
        assert.match(res.path, /^\/.*\/600600-Prílohy zmluvy\.zip$/);
        const { stat } = await import('node:fs/promises');
        assert.ok((await stat(res.path)).size === ATT_PDF_BYTES.length);
    } finally {
        stub.restore();
        await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true });
    }
});

test('attachment: contract without attachments → EMPTY_RESULT with hint', async () => {
    const stub = installFetch([{ match: /\/zmluva\/555555\/$/, body: detailHtml({ pairs: [['ID zmluvy', '555555']] }) }]);
    try {
        const def = await commandDef('attachment');
        await assert.rejects(def.func({ id: '555555' }), /no downloadable attachment/);
    } finally { stub.restore(); }
});

// ── feed (RSS is its own parser, distinct from HTML rows) ───────────────────
test('feed: parses recorded RSS — parties with commas, amounts, https canonical urls', async () => {
    const stub = installFetch([{ match: /data\/static\/rss\.xml/, file: 'feed-rss.xml' }]);
    try {
        const def = await commandDef('feed');
        const items = await def.func({ limit: 5 });
        assert.equal(items.length, 5);
        for (const it of items) {
            assert.equal(typeof it.id, 'number');
            assert.match(it.url, /^https:\/\/www\.crz\.gov\.sk\/zmluva\/\d+\/$/);
            assert.match(it.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
            assert.ok(!it.title.includes('(Cena:'), 'price stripped from title');
        }
        assert.ok(items.every((it) => it.amount == null || typeof it.amount === 'number'));
        assert.ok(items[0].authority && items[0].authority.length > 3);
    } finally { stub.restore(); }

    // tricky: supplier names containing commas + quoted titles
    const stub2 = installFetch([{ match: /rss/, body:
        '<rss><channel><item><title>Zmluva (Cena: 1 234,56 EUR)</title><link>http://crz.gov.sk/zmluva/99887766/</link>'
        + '<description>Objednávateľ: A, B a C, o.p., Dodávateľ: Vzorka, Vzorková</description>'
        + '<pubDate>Sat, 31 Oct 2026 19:50:37 +0100</pubDate></item></channel></rss>' }]);
    try {
        const def = await commandDef('feed');
        const [it] = await def.func({ limit: 1 });
        assert.equal(it.id, 99887766);
        assert.equal(it.amount, 1234.56);
        assert.equal(it.authority, 'A, B a C, o.p.');
        assert.equal(it.supplier, 'Vzorka, Vzorková');
        assert.equal(it.publishedAt, '2026-10-31T18:50:37.000Z');
    } finally { stub2.restore(); }
});

test('fetchBytes: network failure during download is actionable, not a crash', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes('/data/att/')) return Promise.reject(new Error('ECONNRESET'));
        return new Response(fixture('detail-basic.html'), { status: 200 });
    };
    try {
        const def = await commandDef('attachment');
        await assert.rejects(def.func({ id: '99999901', out: `${import.meta.dirname}/.never.pdf` }), /Cannot download/);
    } finally { globalThis.fetch = orig; }
});

// ── operational failure paths (maintenance windows, dead attachments) ──────
test('fetchText: network error and HTTP 500 surface actionable errors', async () => {
    const utils = await import('../utils.js');
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
        const err = await utils.fetchText('https://www.crz.gov.sk/zmluvy/').then(() => null, (e) => e);
        assert.match(err.message, /Cannot reach/);
        assert.match(err.hint, /maintenance/);
    } finally {
        globalThis.fetch = async () => new Response('maintenance', { status: 500 });
        try {
            const err = await utils.fetchText('https://www.crz.gov.sk/zmluvy/').then(() => null, (e) => e);
            assert.match(err.message, /HTTP 500/);
            assert.match(err.hint, /maintenance/);
        } finally { globalThis.fetch = orig; }
    }
});

test('fetchBytes: HTTP 404 on attachment download gets typed not-found hint', async () => {
    const stub = installFetch([
        { match: /\/zmluva\/99999901\/$/, file: 'detail-basic.html' },
        { match: /\/data\/att\//, status: 404, body: 'gone' },
    ]);
    try {
        const def = await commandDef('attachment');
        await assert.rejects(def.func({ id: '99999901' }), /Not found \(HTTP 404\)/);
    } finally { stub.restore(); }
});

test('fetchContract: 200 page without detail markup is rejected, not parsed empty', async () => {
    const stub = installFetch([{ match: /\/zmluva\/333333\/$/, body: '<html><body>redirect splash</body></html>' }]);
    try {
        const def = await commandDef('detail');
        await assert.rejects(def.func({ id: '333333' }), /did not contain expected detail markup/);
    } finally { stub.restore(); }
});

// ── export ───────────────────────────────────────────────────────────────────
test('export: default date is a real yyyy-mm-dd URL; stub archive rejected', async () => {
    const fs = await import('node:fs/promises');
    const stub = installFetch([
        { match: /\/export\/\d{4}-\d{2}-\d{2}\.zip$/, binary: true, file: 'export-empty.zip' },
    ]);
    try {
        const def = await commandDef('export');
        const res = await def.func({ out: `${import.meta.dirname}/.tmp.zip` });
        assert.match(stub.lastUrl(), /\/export\/\d{4}-\d{2}-\d{2}\.zip$/);
        assert.ok(stub.lastUrl().includes(res.date));
        await assert.rejects(def.func({ date: '2026-1-2' }), /Invalid date/);
    } finally {
        stub.restore();
        await fs.rm(`${import.meta.dirname}/.tmp.zip`, { force: true });
    }

    const stub2 = installFetch([{ match: /\/export\//, body: '<html>error page</html>' }]);
    try {
        const def = await commandDef('export');
        await assert.rejects(def.func({ date: '2026-10-30', out: `${import.meta.dirname}/.tmp2.zip` }), /not a ZIP archive/);
        const { existsSync } = await import('node:fs');
        assert.ok(!existsSync(`${import.meta.dirname}/.tmp2.zip`), 'rejected archive must not be written');
    } finally { stub2.restore(); }
});
