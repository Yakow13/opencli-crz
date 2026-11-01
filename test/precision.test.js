/**
 * M0a — correctness pass (§11 F1,F3,F4,F5,F6,F7,F8). Written failing-first:
 * every test here encodes the TARGET behaviour that the field review proved
 * is missing. Green means the false-negatives/silent-truncation class is dead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixtures.js';
import { installFetch, paramsOf } from './helpers/fetch-stub.js';
import { rowsHtml } from './helpers/synth.js';
import { commandDef } from './helpers/commands.js';
import { parseRows, parseDetail } from '../utils.js';

const FORM = { match: /\/zmluvy\/$/, file: 'form-zmluvy.html' };

// ── F8: row noise flags ──────────────────────────────────────────────────────
test('parseRows: numberEcho and amountStated flags', () => {
    const rows = parseRows(rowsHtml([
        { id: 100001, title: 'Objednávka dopravy', number: 'Objednávka dopravy', amount: '0,00&nbsp;&euro;' },
        { id: 100002, title: 'Rámcová zmluva', number: '4600008607/PT/2025', amount: '1 000,00&nbsp;&euro;' },
        { id: 100003, title: 'X', number: null, amount: '' },
    ]));
    assert.equal(rows[0].numberEcho, true);    // number literally repeats the title (§1 F8)
    assert.equal(rows[0].amountStated, false); // 0,00 = unpriced ceiling convention
    assert.equal(rows[1].numberEcho, false);
    assert.equal(rows[1].amountStated, true);
    assert.equal(rows[2].amountStated, false);
});

// ── F3/F4: IČO attribution by party block + IČO hidden in name text ─────────
test('parseDetail: IČO inside the supplier name string is extracted and sourced', () => {
    const d = parseDetail(fixture('detail-ico-in-name.html'));  // contract 99999902
    assert.equal(d.supplierIco, '45678901');   // visible on the page ⇒ must not be null
    assert.equal(d.authorityIco, '45678902');  // the single IČO: label belongs to the authority block
    assert.deepEqual(d.icoSource, { authority: 'form', supplier: 'name-field' });
    const sup = d.parties.find((p) => p.role === 'supplier');
    assert.ok(!/I\s*C\s*O/i.test(sup.name), 'IČO segment removed from party name');
    assert.ok(sup.name.startsWith('F & G STAVBY s.r.o.'));
});

test('parseDetail: parties[] split by role with block-proximate IČOs', () => {
    const d = parseDetail(fixture('detail-name-change.html'));  // 99999904 "X & Y Invest" under IČO 45678901
    const byRole = Object.fromEntries(d.parties.map((p) => [p.role, p]));
    assert.equal(byRole.supplier.name, 'X & Y Invest, spol. s r.o.');
    assert.equal(byRole.supplier.ico, '45678901');
    assert.equal(byRole.supplier.icoSource, 'form');
    assert.ok(byRole.authority.name && byRole.authority.address);
    // legacy flat fields stay for existing consumers
    assert.equal(d.supplierIco, '45678901');

    const basic = parseDetail(fixture('detail-basic.html'));
    assert.equal(basic.parties.length, 2);
    assert.equal(basic.parties.find((p) => p.role === 'authority').ico, '00000001');
    assert.equal(basic.parties.find((p) => p.role === 'supplier').ico, null);
});

// ── F6: envelope — no silent truncation, no silent empty ────────────────────
test('search: envelope exposes page state instead of a bare slice', async () => {
    const stub = installFetch([FORM, { match: /centralny-register-zmluv/, file: 'search-kupna.html' }]);
    try {
        const def = await commandDef('search');
        const env = await def.func({ query: 'kúpna', page: 0, limit: 5 });
        assert.ok(Array.isArray(env.rows));
        assert.equal(env.rows.length, 5);
        assert.equal(env.rowCount, 20, 'rows on page before slice');
        assert.equal(env.page, 0);
        assert.equal(env.hasMore, true);
        assert.equal(env.pageCount, null, 'exact total unknown mid-window — must not guess');
        assert.ok(env.pageWindowMax >= 11, 'pager window gives a lower bound');
        assert.ok('query' in env);
    } finally { stub.restore(); }
});

test('search: zero rows is a typed EMPTY_RESULT with recovery hints, not []', async () => {
    const stub = installFetch([
        FORM,
        { match: /art_predmet=bez-vysledku/, file: 'party-space-amp.html' }, // the 0-row page
    ]);
    try {
        const def = await commandDef('search');
        const err = await def.func({ query: 'bez-vysledku' }).then(() => null, (e) => e);
        assert.equal(err.code, 'EMPTY_RESULT');
        assert.match(err.hint, /fulltext|variant|collect/);
    } finally { stub.restore(); }
});

// ── F5: false-negative party queries auto-retry variants ────────────────────
test('search: "F & G STAVBY" returns 0 → retries glued variant, reports usedQuery', async () => {
    const stub = installFetch([
        FORM,
        { match: /art_zs2=F\+%26\+G/, file: 'party-space-amp.html' },   // real 0-row page (URL-encoded spaces = +)
        { match: /art_zs2=F%26G/, file: 'party-glued.html' },            // real 20-row page
    ]);
    try {
        const def = await commandDef('search');
        const env = await def.func({ supplier: 'F & G STAVBY', limit: 3 });
        assert.equal(env.rows.length, 3);
        assert.equal(env.usedQuery.used, 'F&G STAVBY');
        assert.ok(env.usedQuery.attempted.includes('F & G STAVBY'));
        assert.ok(stub.calls.some((c) => /art_zs2=F%26G/.test(c.url)), 'variant leg actually requested');
    } finally { stub.restore(); }
});

test('search: --exact-party post-filters tokenized strangers', async () => {
    const strangers = rowsHtml([
        { id: 110001, sup: 'ACME invest, a.s.', auth: 'Úrad A', title: 'X' },
        { id: 110002, sup: 'Invest Capital s.r.o.', auth: 'Úrad B', title: 'Y' },
        { id: 110003, sup: 'ACME, invest a.s.', auth: 'Úrad C', title: 'Z' },
    ]);
    const stub = installFetch([FORM, { match: /centralny-register-zmluv/, body: strangers }]);
    try {
        const def = await commandDef('search');
        const env = await def.func({ supplier: 'invest', 'exact-party': 'ACME invest', limit: 20 });
        assert.deepEqual(env.rows.map((r) => r.id), [110001, 110003]); // diacritic/space/punct tolerant
        assert.equal(env.postFiltered, 'exact-party');
    } finally { stub.restore(); }
});

// ── F7: --number is substring upstream → default exact post-filter ──────────
test('search: --number keeps exact matches by default; --number-contains opts out', async () => {
    const nums = rowsHtml([
        { id: 120001, number: 'VZ-9999/2026', title: 'A' },
        { id: 120002, number: 'VZ-9999/2026-extra', title: 'B' },
    ]);
    const stub = installFetch([FORM, { match: /centralny-register-zmluv/, body: nums }]);
    try {
        const def = await commandDef('search');
        const exact = await def.func({ number: 'VZ-9999/2026', limit: 20 });
        assert.deepEqual(exact.rows.map((r) => r.id), [120001]);
        assert.equal(exact.postFiltered, 'exact-number');
        const loose = await def.func({ number: 'VZ-9999/2026', 'number-contains': true, limit: 20 });
        assert.deepEqual(loose.rows.map((r) => r.id), [120001, 120002]);
    } finally { stub.restore(); }
});

// ── F1: --party-ico unions both role legs (each alone is lossy) ─────────────
test('search: --party-ico merges supplier+authority IČO legs, dedupes, tags provenance', async () => {
    const supLeg = rowsHtml([{ id: 130001, sup: 'F&G', auth: 'DP A' }, { id: 130002, sup: 'F&G', auth: 'DP B' }]);
    const authLeg = rowsHtml([{ id: 130002, sup: 'Dod', auth: 'F&G' }, { id: 130003, sup: 'Dod', auth: 'F&G' }]);
    const stub = installFetch([
        FORM,
        { match: /art_ico=45678901/, body: supLeg },
        { match: /art_ico1=45678901/, body: authLeg },
    ]);
    try {
        const def = await commandDef('search');
        const env = await def.func({ 'party-ico': '45678901', limit: 20 });
        assert.deepEqual(env.rows.map((r) => r.id).sort(), [130001, 130002, 130003]);
        const r2 = env.rows.find((r) => r.id === 130002);
        assert.deepEqual([...r2.partyRoles].sort(), ['authority', 'supplier'], 'overlap visible in BOTH legs');
        assert.deepEqual(env.rows.find((r) => r.id === 130001).partyRoles, ['supplier']);
        assert.deepEqual(env.rows.find((r) => r.id === 130003).partyRoles, ['authority']);
        assert.equal(env.matchedBy, 'ico-union');
        assert.equal(env.legs.supplier.rowCount, 2);
        assert.equal(env.legs.authority.rowCount, 2);
    } finally { stub.restore(); }
});

// ── fulltext inherits the envelope + empty semantics ────────────────────────
test('fulltext: same envelope shape as search', async () => {
    const stub = installFetch([
        FORM,
        { match: /search=festival/, file: 'fulltext-koncert.html' },
        { match: /search=nic/, file: 'party-space-amp.html' },
    ]);
    try {
        const def = await commandDef('fulltext');
        const env = await def.func({ term: 'festival koncert', limit: 4 });
        assert.equal(env.rows.length, 4);
        assert.equal(env.hasMore, true);
        await assert.rejects(def.func({ term: 'nic' }), (e) => e.code === 'EMPTY_RESULT');
    } finally { stub.restore(); }
});
