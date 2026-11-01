/**
 * `crz entity` (M0b) — one call answering "all contracts of this company",
 * the union the §11 field review proved single legs cannot answer.
 * Two modes: mirror (exact, alias-bridged) and site (live legs + post-filter).
 * Universe: fictional F & G STAVBY (IČO 45678901) — see test/README.md doctrine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installFetch } from './helpers/fetch-stub.js';
import { rowsHtml } from './helpers/synth.js';
import { makeStoredZip, DAY1_XML, DAY2_XML } from './helpers/mirror-fixtures.js';
import { commandDef } from './helpers/commands.js';

const SYNC_STUB = [
    { match: /\/export\/2026-01-02\.zip$/, body: makeStoredZip('a.xml', DAY1_XML) },
    { match: /\/export\/2026-01-03\.zip$/, body: makeStoredZip('b.xml', DAY2_XML) },
];

async function seededDb() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-ent-'));
    const db = path.join(dir, 'm.sqlite');
    const stub = installFetch(SYNC_STUB);
    try {
        const sync = await commandDef('sync');
        await sync.func({ since: '2026-01-02', until: '2026-01-03', db, 'delay-ms': 0 });
    } finally { stub.restore(); }
    return { dir, db };
}

// DAY1 fixture universe: 'Firm s.r.o.' IČO 11111111 sells twice — contract
// 9000001 (priced 2500 after day2 update) + 9000002 with BLANK ico (1500).
test('entity: db mode unions IČO legs with alias-bridged blank-ico rows', async () => {
    const { dir, db } = await seededDb();
    try {
        const def = await commandDef('entity');
        const res = await def.func({ ico: '11111111', db });
        assert.equal(res.source, 'db');
        assert.equal(res.contracts, 2);
        assert.equal(res.blankIcoRows, 1);
        const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));
        assert.equal(byId[9000001].matchedBy, 'ico');
        assert.equal(byId[9000002].matchedBy, 'name');     // the §11 F1 recall via aliases
        assert.equal(byId[9000002].partyRoles.join(), 'supplier');
        assert.equal(res.sumByRole.supplier, 4000);         // 2500 + 1500 — the honest total
        assert.deepEqual(res.byYear['2026'], { contracts: 2, sum: 4000 });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('entity: db mode authority side + --year filter + typed empty', async () => {
    const { dir, db } = await seededDb();
    try {
        const def = await commandDef('entity');
        const auth = await def.func({ ico: '00000001', db });
        assert.equal(auth.contracts, 2);
        assert.equal(auth.sumByRole.authority, 4000);       // Obec One bought 4000 total
        assert.ok(auth.rows.every((r) => r.partyRoles.includes('authority')));

        const filtered = await def.func({ ico: '11111111', db, year: 2026 });
        assert.equal(filtered.contracts, 2);
        await assert.rejects(def.func({ ico: '11111111', db, year: 2020 }), /found no contracts/i);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('entity: site mode unions 4 legs, post-filters loose-LIKE strangers, dedupes', async () => {
    const fgPage = rowsHtml([
        { id: 5000001, sup: 'F & G STAVBY s.r.o.', auth: 'Doprava Podnik, a.s.' },
        { id: 5000002, sup: 'F & G STAVBY, s.r.o.', auth: 'Obec VZOR' },        // comma variant — same norm family
        { id: 5000005, sup: 'F & G STAVBY s.r.o. Metodova 9 82109 Bratislava IČO: 45678901', auth: 'Úrad VZOR' }, // blob variant (§11 F3 shape)
    ]);
    const authPage = rowsHtml([
        { id: 5000101, sup: 'Klient X', auth: 'F & G STAVBY s.r.o.' },
    ]);
    const stub = installFetch([
        { match: /\/zmluvy\/$/, body: '<html><form id="frm_filter_3" action="/2171273-sk/centralny-register-zmluv/" method="get"></form></html>' },
        { match: /art_ico1=45678901/, body: authPage },
        { match: /art_ico=45678901/, body: fgPage },
        { match: /art_zs[12]=/, body: rowsHtml([
            { id: 5000001, sup: 'F & G STAVBY s.r.o.', auth: 'Doprava Podnik, a.s.' }, // overlap with ico leg
            { id: 5000004, sup: 'F & G STAVBY s.r.o.', auth: 'Nemocnica VZOR' },        // blank-ico row only name finds
            { id: 5000003, sup: 'Stavebniny F & G STAVBY AREAL, s.r.o.', auth: 'Okres VZOR' }, // stranger again
        ]) },
    ]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-nodb-'));
    const db = path.join(dir, 'absent.sqlite'); // forces site mode
    try {
        const def = await commandDef('entity');
        const res = await def.func({ ico: '45678901', db, 'max-pages': 1, 'delay-ms': 0 });
        assert.equal(res.source, 'site');
        const ids = res.rows.map((r) => r.id).sort();
        assert.deepEqual(ids, [5000001, 5000002, 5000004, 5000005, 5000101]);  // stranger 5000003 excluded, overlap deduped
        assert.equal(res.rows.find((r) => r.id === 5000005).matchedBy, 'ico'); // blob row kept via IČO leg…
        assert.ok(!res.nameVariantsUsed.some((v) => /IČO/.test(v)), 'blob variants never probed as name legs');
        assert.ok(res.nameVariantsUsed.every((v) => v.length <= 48));           // shortest clean representative
        const byId = Object.fromEntries(res.rows.map((r) => [r.id, r]));
        assert.equal(byId[5000001].matchedBy, 'ico');
        assert.equal(byId[5000004].matchedBy, 'name');
        assert.deepEqual(byId[5000101].partyRoles, ['authority']);
        assert.ok(res.nameVariantsUsed.length >= 1);
        assert.ok(res.hint.includes('sync'));                          // teaches the agent about the mirror
    } finally {
        stub.restore();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('entity: invalid IČO rejected pre-network', async () => {
    const stub = installFetch([]);
    try {
        const def = await commandDef('entity');
        await assert.rejects(def.func({ ico: '12' }), /Invalid IČO/);
        assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
});
