/**
 * Topic 1: parsing layer against recorded fixtures + synthetic edge combos.
 * All list commands share parseRows, all detail consumers share parseDetail —
 * behaviour pinned here once, protected everywhere (no per-command duplication).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/fixtures.js';
import { rowsHtml, detailHtml } from './helpers/synth.js';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
    decodeEntities, htmlToText, normalizeDiacritics, parseSlovakDate, parseAmount,
    toSiteDate, contractId, parseRows, hasMorePages, parseDetail,
} from '../utils.js';

// ── decodeEntities / htmlToText ──────────────────────────────────────────────
test('decodeEntities: named, decimal, hex, unknown passthrough', () => {
    assert.equal(decodeEntities('133,30&nbsp;&euro;'), '133,30\u00a0\u20ac');
    assert.equal(decodeEntities('&#8217; &#x165;'), '\u2019 ť');
    assert.equal(decodeEntities('&totallyunknown;'), '&totallyunknown;');
    assert.equal(decodeEntities('GA&Scaron;TA'), 'GAŠTA');
    assert.equal(decodeEntities('ga&scaron;ta'), 'gašta');
});

test('htmlToText: tags fold to lines, comments dropped, spaces collapsed', () => {
    const html = '<div class="row"><!-- x --><strong>Typ:</strong></div>\n<span>Obec<br/>VZOR\n  74</span>';
    assert.equal(htmlToText(html), 'Typ:\nObec\nVZOR\n74'); // source text contained a literal newline
});

// ── dates & amounts ──────────────────────────────────────────────────────────
test('parseSlovakDate: all site formats incl. genitive months', () => {
    assert.equal(parseSlovakDate('31. Október 2026'), '2026-10-31');
    assert.equal(parseSlovakDate('30. Október 2026'), '2026-10-30');
    assert.equal(parseSlovakDate('1. marec 2011'), '2011-03-01');          // lowercase
    assert.equal(parseSlovakDate('3. marca 2024'), '2024-03-03');          // genitive
    assert.equal(parseSlovakDate('29. Februára 2024'), '2024-02-29');
    assert.equal(parseSlovakDate('5. mája 2020'), '2020-05-05');
    assert.equal(parseSlovakDate('15. Jan 2025'), '2025-01-15');           // short form
    assert.equal(parseSlovakDate('26.10.2026'), '2026-10-26');             // numeric
    assert.equal(parseSlovakDate('2026-10-26'), '2026-10-26');             // ISO passthrough
    assert.equal(parseSlovakDate('neuvedený'), null);
    assert.equal(parseSlovakDate('deň nasledujúci po dni zverejnenia'), null);
    assert.equal(parseSlovakDate(''), null);
});

test('parseAmount: spaced thousands, decimal comma, empty', () => {
    assert.deepEqual(parseAmount('1 918 766,54\u00a0€'), { value: 1918766.54, raw: '1 918 766,54\u00a0€' });
    assert.equal(parseAmount('0,00 €').value, 0);
    assert.equal(parseAmount('133,30 €').value, 133.3);
    assert.equal(parseAmount('133,30&nbsp;&euro;').value, 133.3);
    assert.equal(parseAmount('1.918.766,54').value, 1918766.54);
    assert.equal(parseAmount('1.918.765').value, 1918765);   // dotted thousands, no decimal
    assert.equal(parseAmount('').value, null);
    assert.deepEqual(parseAmount(undefined), { value: null, raw: '' });
});

test('toSiteDate: ISO and CZ/SK input normalize to dd.MM.yyyy', () => {
    assert.equal(toSiteDate('2026-10-01', 'published-from'), '01.10.2026');
    assert.equal(toSiteDate('1.10.2026', 'published-from'), '01.10.2026');
    assert.throws(() => toSiteDate('2026-13', 'x'), ArgumentError);
});

test('contractId: accepts id, trailing slash and full URL; rejects junk', () => {
    assert.equal(contractId('99999901'), '99999901');
    assert.equal(contractId('99999901/'), '99999901');
    assert.equal(contractId('https://www.crz.gov.sk/zmluva/99999901/'), '99999901');
    assert.throws(() => contractId('abc'), ArgumentError);
    assert.throws(() => contractId(''), ArgumentError);
});

// ── parseRows ────────────────────────────────────────────────────────────────
test('parseRows: three real list variants agree on shape', () => {
    for (const name of ['search-kupna.html', 'fulltext-koncert.html', 'list-amendments.html']) {
        const rows = parseRows(fixture(name));
        assert.equal(rows.length, 20, name);
        for (const r of rows) {
            assert.ok(r.id >= 100000 && Number.isInteger(r.id));
            assert.match(r.url, /^https:\/\/www\.crz\.gov\.sk\/(zmluva\/)?\d+\/$/);
            assert.ok(r.title.length > 0);
            assert.equal(typeof r.amount, 'number');
            assert.ok(r.url === `https://www.crz.gov.sk/zmluva/${r.id}/` || r.url === `https://www.crz.gov.sk/${r.id}/`);
        }
    }
});

test('parseRows: legacy amendment row linked under bare /<id>/ is kept, status badge captured', () => {
    const rows = parseRows(fixture('list-amendments.html'));
    const legacy = rows.find((r) => r.id === 9900047);
    assert.ok(legacy, 'legacy row dropped from amendments list');
    assert.equal(legacy.url, 'https://www.crz.gov.sk/9900047/');
    assert.match(legacy.status, /Doplnen/);
    assert.ok(rows.every((r) => r.status === null || /Doplnen/i.test(r.status)));
});

test('parseRows: synthetic edge combos', () => {
    const rows = parseRows(rowsHtml([
        { id: 111111, title: 'Bez čísla', number: null, amount: '0,00&nbsp;&euro;' },
        { id: 222222, title: 'Záporná?', amount: '-5,00&nbsp;&euro;', sup: 'A&nbsp;&amp;&nbsp;B', auth: 'Mesto\n<br/>Kde' },
    ]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].number, '');
    assert.equal(rows[1].amount, -5);
    assert.equal(rows[1].supplier, 'A & B');
    assert.equal(rows[1].authority, 'Mesto Kde');
    assert.equal(parseRows('<html><body>no table</body></html>').length, 0);
});

test('hasMorePages: pager link wins, 20-row heuristic is fallback', () => {
    assert.equal(hasMorePages(fixture('search-kupna.html'), 0, 20), true);
    assert.equal(hasMorePages(rowsHtml([{}], { nextPage: 3 }), 2, 20), true);
    assert.equal(hasMorePages(rowsHtml([]), 0, 19), false);
    assert.equal(hasMorePages(rowsHtml([]), 0, 20), true); // full page, no pager → assume more
});

// ── parseDetail ──────────────────────────────────────────────────────────────
test('parseDetail: fixture regressions that actually happened once', () => {
    const d = parseDetail(fixture('detail-basic.html'));
    // regression: greedy <strong> pairing used to swallow the whole nav menu into extra
    const longKeys = Object.keys(d.extra ?? {});
    assert.ok(longKeys.every((k) => k.length < 40), `extra polluted: ${longKeys.slice(0, 2)}`);
    // regression: amounts rendered outside the strong/span grid were lost
    assert.equal(d.agreedAmount, 100);
    assert.equal(d.totalAmount, 200);
    assert.equal(d.validUntil, 'neuvedený');
    assert.equal('validUntilDate' in d, true);
    assert.equal(d.validUntilDate, null);
});

test('parseDetail: IČO order, note, subject, unknown labels', () => {
    const full = parseDetail(fixture('detail-full.html'));
    assert.equal(full.authorityIco, '45678902');
    assert.equal(full.supplierIco, '00000009');
    assert.equal(full.effectiveAt, 'deň nasledujúci po dni zverejnenia');
    assert.equal(full.effectiveAtDate, null);

    const d = parseDetail(detailHtml({ pairs: [
        ['Názov zmluvy', 'X'],
        ['Predmet plnenia', 'Dodávka water'],
        ['Poznámka', 'dup on'],
        ['Banská Štiavnica', 'neznámy'],
    ] }));
    assert.equal(d.subject, 'Dodávka water');
    assert.equal(d.note, 'dup on');
    assert.deepEqual(d.extra, { 'Banská Štiavnica': 'neznámy' });
});

test('parseDetail: validUntil date overwrites raw with ISO', () => {
    const d = parseDetail(detailHtml({ pairs: [['Dátum platnosti do', '31.12.2027'], ['ID zmluvy', '42']] }));
    assert.equal(d.validUntil, '2027-12-31');
    assert.equal(d.id, 42);
});

test('parseDetail: attachments parsed, ext + size, duplicate URLs deduped', () => {
    const d = parseDetail(detailHtml({ atts: [
        { url: '/data/att/999.pdf', name: 'Zmluva', ext: '.pdf', size: '1 kB' },
        { url: '/data/att/999.pdf', name: 'Zmluva', ext: '.pdf', size: '1 kB' },
        { url: '/data/att/1000.zip', name: 'Prílohy', ext: '.zip', size: '2 MB' },
    ] }));
    assert.equal(d.attachments.length, 2);
    assert.equal(d.attachments[0].ext, 'pdf');
    assert.equal(d.attachments[0].sizeText, '1 kB');
    assert.equal(d.attachments[1].url, 'https://www.crz.gov.sk/data/att/1000.zip');
});

test('parseDetail: only-total variant still yields totalAmount, no agreed', () => {
    const d = parseDetail(detailHtml({ amounts: false, pairs: [['ID zmluvy', '7']] }));
    assert.equal(d.totalAmount, 200);
    assert.equal(d.agreedAmount ?? null, null);
});

test('normalizeDiacritics', () => {
    assert.equal(normalizeDiacritics('Ministerstvo fiktívne SR'), 'ministerstvo fiktivne sr');
});
