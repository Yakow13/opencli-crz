/**
 * Ground-truth harness proof: fixtures are intact, commands load, parsers
 * return real recorded data, and the stubbed-fetch path reproduces the exact
 * outgoing URLs the site expects. Full behavioural suites build on this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, fixtureNames, manifest } from './helpers/fixtures.js';
import { installFetch, paramsOf } from './helpers/fetch-stub.js';
import { commandDef } from './helpers/commands.js';
import { parseRows, parseDetail } from '../utils.js';

test('fixtures: manifest matches disk', () => {
    for (const name of fixtureNames()) {
        const entry = manifest[name];
        assert.ok(!/FAILED/.test(entry.purpose), `${name} capture failed: rerun build-fixtures.js`);
        const file = path.join(import.meta.dirname, 'fixtures', name);
        assert.ok(fs.existsSync(file) || name === 'diff-sample.xml', `${name} missing from disk`);
        assert.equal(fs.readFileSync(file).length, entry.bytes, `${name} size drift`);
    }
    assert.ok(fixtureNames().length >= 13);
});

test('registry: all 12 commands register with func + access metadata', async () => {
    const names = ['search', 'fulltext', 'recent', 'amendments', 'terminated', 'detail',
        'attachment', 'export', 'feed', 'collect', 'profile', 'evidence'];
    for (const n of names) {
        const def = await commandDef(n);
        assert.equal(typeof def.func, 'function', `${n} has no func`);
        assert.equal(def.access, 'read', `${n} access`);
        assert.ok(def.args.some((a) => a.help), `${n} args lack help text`);
    }
});

test('parseRows: real search fixture yields 20 well-typed rows', () => {
    const rows = parseRows(fixture('search-kupna.html'));
    assert.equal(rows.length, 20);
    const r = rows[0];
    assert.equal(typeof r.id, 'number');
    assert.match(r.url, /https:\/\/www\.crz\.gov\.sk\/zmluva\/\d+\//);
    assert.match(r.publishedAt, /^\d{4}-\d{2}-\d{2}$/); // "30. Október 2026" → ISO
    assert.equal(typeof r.amount, 'number');             // "133,30 €" → 133.3 style
    assert.ok(r.title && r.supplier && r.authority);
});

test('parseDetail: recorded contract pages parse into typed fields', () => {
    const basic = parseDetail(fixture('detail-basic.html'));
    assert.equal(basic.id, 99999901);
    assert.equal(basic.agreedAmount, 100);          // span/span + strong/strong variants
    assert.equal(basic.totalAmount, 200);
    assert.equal(basic.publishedAtDate, '2026-10-30');
    assert.equal(basic.authorityIco, '00000001');     // single IČO routes to authority
    assert.equal(basic.supplierIco, undefined);
    assert.equal(basic.attachments.length, 1);
    assert.match(basic.attachments[0].url, /\/data\/att\/\d+\.pdf$/);

    const full = parseDetail(fixture('detail-full.html'));
    assert.equal(full.authorityIco, '45678902');      // order-sensitive: 1st authority, 2nd supplier
    assert.equal(full.supplierIco, '00000009');
    assert.ok(full.note.includes('VZOR REALITY'), 'note with additional suppliers');
    assert.equal(full.totalAmount, 200);
    assert.equal(full.attachments[0].sizeText, '512 kB');
});

test('command def.func end-to-end over stubbed fetch: search URL contract', async () => {
    const stub = installFetch([
        { match: /\/zmluvy\/$/, file: 'form-zmluvy.html' },                              // resolveSearchPath
        { match: /centralny-register-zmluv/, file: 'search-kupna.html' },                 // results
    ]);
    try {
        const def = await commandDef('search');
        const env = await def.func({ query: 'kúpna', page: 0, limit: 5 });
        assert.equal(env.rows.length, 5);
        assert.equal(env.rowCount, 20);
        assert.equal(stub.calls.length, 2);
        const params = paramsOf(stub.lastUrl());
        assert.equal(params.art_predmet, 'kúpna');   // kebab/positional → site param (regression: args['min-amount'] class of bug)
        assert.equal(params.odoslat, '1');
        assert.ok(!('page' in params));               // page=0 must stay absent
    } finally {
        stub.restore();
    }
});

test('stub serves recorded 404 for unknown contract (detail error path shape)', async () => {
    const stub = installFetch([
        { match: /zmluva\/999999999/, file: 'detail-missing.html', status: 404 },
        { match: /\/999999999\/$/, file: 'detail-missing.html', status: 404 }, // legacy fallback attempt too
    ]);
    try {
        const def = await commandDef('detail');
        await assert.rejects(def.func({ id: '999999999' }), /HTTP 404/);
    } finally {
        stub.restore();
    }
});
