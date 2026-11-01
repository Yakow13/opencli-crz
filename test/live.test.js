/**
 * Live tier — OFF by default. Run with CRZ_LIVE=1 to verify the recorded
 * fixtures still describe reality (schema drift detector). Never gate
 * refactors on this file; it is allowed to fail while the suite stays green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { commandDef } from './helpers/commands.js';

const LIVE = process.env.CRZ_LIVE === '1';
const opts = { skip: LIVE ? false : 'set CRZ_LIVE=1 to run against the live site' };

test('live: recent list still renders parseable rows', opts, async () => {
    const def = await commandDef('recent');
    const rows = await def.func({ limit: 3 });
    assert.ok(rows.length >= 1, 'CRZ returned no recent contracts — site down or layout drift');
    assert.ok(rows[0].id > 100000 && typeof rows[0].amount === 'number');
});

test('live: search round-trip with a stable-ish query', opts, async () => {
    process.env.OPENCLI_CRZ_CACHE = '0';
    const def = await commandDef('search');
    const env = await def.func({ query: 'kúpna zmluva', publishedFrom: undefined, limit: 5 });
    assert.ok(env.rows.length >= 5);
    const id = env.rows[0].id;
    const d = await commandDef('detail');
    const detail = await d.func({ id: String(id) });
    assert.equal(detail.id, id);
    assert.ok(detail.title);
});
