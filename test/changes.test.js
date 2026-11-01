/**
 * Phase 2 / M1 — `crz changes`: differential ZIP + XML ingest, test-first.
 * Fixtures are REAL CRZ artifacts (see build-fixtures.js): deflate-compressed nightly
 * records, stored-compressed empty archive, empty-<ico> record from the wild.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers/fixtures.js';
import { installFetch } from './helpers/fetch-stub.js';
import { commandDef } from './helpers/commands.js';
import { readZip, parseDiffXml } from '../diff.js';

// ── ZIP reader: both compression methods found in real CRZ archives ─────────
test('readZip: deflate entry (method 8, real nightly format)', () => {
    const entries = readZip(fixture('diff-sample.zip', { raw: true }));
    const names = [...entries.keys()];
    assert.equal(names.length, 1);
    assert.match(names[0], /^\d{4}-\d{2}-\d{2}\.xml$/);
    assert.ok(entries.get(names[0]).toString('utf8').startsWith('<?xml'));
});

test('readZip: stored entry (method 0, real empty archive) + trailing-comment tolerance', () => {
    const entries = readZip(fixture('export-empty.zip', { raw: true }));  // 175 B, method 0
    assert.equal(entries.size, 1);
    const [xml] = [...entries.values()];
    assert.equal(xml.toString('utf8'), '<?xml version="1.0" encoding="UTF-8"?>\n<zmluvy/>\n');
});

test('readZip: rejects non-zip input with an actionable error', () => {
    assert.throws(() => readZip(Buffer.from('<html>error page</html>')), /not a ZIP/i);
});

// ── diff XML → normalized events ────────────────────────────────────────────
test('parseDiffXml: pinned nightly sample yields schema-complete rows', () => {
    const events = parseDiffXml(fixture('diff-sample.xml'));
    assert.equal(events.length, 2);
    for (const e of events) {
        assert.ok(Number.isInteger(e.crzid), 'crzid parsed');
        assert.ok(['contract', 'amendment'].includes(e.kind));
        assert.ok(e.title && e.authority && e.supplier);
        assert.match(e.publishedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        assert.ok(['present', 'blank', 'absent'].includes(e.icoSourceFlag));
        for (const a of e.attachments) assert.match(a.url, /^https:\/\/www\.crz\.gov\.sk\/data\/att\/\S+$/);
    }
});

// value-locked against the DETERMINISTIC synthetic fixture (regenerate → same bytes)
test('parseDiffXml: synthetic nightly record fully normalized (value-locked)', () => {
    const [e] = parseDiffXml(fixture('diff-sample.xml'));
    assert.equal(e.crzid, 7700001);
    assert.equal(e.title, 'Dodatok č.1 k zmluve č.27622 - vZOR dvor');
    assert.equal(e.authority, 'Obec VZOR');
    assert.equal(e.supplier, 'ALFA STAV s.r.o.');
    assert.equal(e.authorityIco, '00000001');   // leading zeros preserved (string!)
    assert.equal(e.supplierIco, '12345678');
    assert.equal(e.authorityAddress, 'Zeleznicna 4/320, VZOR');
    assert.equal(e.supplierAddress, 'SNP 711/15, Velky VZOR');
    assert.equal(e.kind, 'amendment');          // Dodatok prefix heuristic
    assert.equal(e.sumOriginal, 212679.78);
    assert.equal(e.sumTotal, 212679.78);
    assert.equal(e.closedAt, '2022-11-15');
    assert.equal(e.publishedAt, '2022-11-16T10:00:18');
    assert.equal(e.effectiveAt, '2022-11-17');
    assert.equal(e.validUntil, null);           // 0000-00-00 sentinel → null
    assert.equal(e.stav, '2');
    assert.equal(e.rezortRaw, '6215909');       // DIFFERENT id-space than web form — kept raw
    assert.equal(e.legacyId, 46182);
    assert.equal(e.sourceRef, 'https://www.vzor.example/crz/contract/43206');
    assert.equal(e.changeTs, '2022-11-16 10:00:18');
    assert.equal(e.icoSourceFlag, 'present');
    assert.deepEqual(e.attachments, [{
        attId: 7700002,
        name: 'dodatok_vzor_zverej',
        file: '99000111.pdf',
        url: 'https://www.crz.gov.sk/data/att/99000111.pdf',
        bytes: 0,
        changedAt: '2026-10-30 13:47:45',
    }]);
});

test('parseDiffXml: empty day yields [] (legit, not an error)', () => {
    assert.deepEqual(parseDiffXml('<?xml version="1.0"?><zmluvy/>'), []);
});

test('parseDiffXml: empty <ico> — the §11 F2 recall gap survives ingest as null, never dropped', () => {
    const events = parseDiffXml(fixture('diff-ico-blank.xml'));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.crzid, 99999903);
    assert.equal(e.supplierIco, null);      // blank at source
    assert.equal(e.authorityIco, '45678902');
    assert.equal(e.supplier.includes('F & G STAVBY'), true);
    assert.equal(e.icoSourceFlag, 'blank');  // provenance for the alias layer (M2)
});

test('parseDiffXml: malformed/unknown blocks are skipped, not fatal', () => {
    const xml = '<zmluvy><zmluva><garbage>yes</garbage></zmluva>'
        + '<zmluva><ID>5555555</ID><nazov>ok</nazov></zmluva>broken<zmluva><x>'
        + '</zmluvy>';
    const events = parseDiffXml(xml);
    assert.equal(events.length, 2);          // minimal record survives with nulls
    assert.equal(events[0].crzid, null);     // garbage block kept but flagged
    assert.equal(events[0].title, null);
    assert.equal(events[1].crzid, 5555555);
});

// ── changes command wiring ───────────────────────────────────────────────────
test('changes: date → ZIP → events; empty day is success with 0 events, not an error', async () => {
    const zip = fixture('diff-sample.zip', { raw: true });
    const stub = installFetch([{ match: /\/export\/2026-10-30\.zip$/, body: zip }]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crz-changes-'));
    try {
        const def = await commandDef('changes');
        const res = await def.func({ date: '2026-10-30', out: `${dir}/events.jsonl` });
        assert.equal(res.date, '2026-10-30');
        assert.equal(res.events, 2);
        assert.equal(res.bytes, zip.length);
        const lines = (await fs.readFile(`${dir}/events.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(lines.length, 2);
        assert.ok(Number.isInteger(lines[0].crzid));

        const emptyDay = installFetch([{ match: /\/export\//, body: fixture('export-empty.zip', { raw: true }) }]);
        try {
            const res2 = await def.func({ date: '2020-01-01' });
            assert.equal(res2.events, 0);     // NOT an EmptyResultError — zero is data
            assert.equal(res2.isEmptyDay, true);
        } finally { emptyDay.restore(); }
    } finally {
        stub.restore();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('changes: bad date rejected pre-network; non-ZIP rejected', async () => {
    const stub = installFetch([]);
    try {
        const def = await commandDef('changes');
        await assert.rejects(def.func({ date: '2026-13-45' }), /Invalid date|must be/);
        await assert.rejects(def.func({ date: 'yesterday-ish' }), /Invalid date|must be/);
        assert.equal(stub.calls.length, 0);
    } finally { stub.restore(); }
    const stub2 = installFetch([{ match: /\/export\//, body: '<html>nope</html>' }]);
    try {
        const def = await commandDef('changes');
        await assert.rejects(def.func({ date: '2026-10-30' }), /not a ZIP/i);
    } finally { stub2.restore(); }
});
