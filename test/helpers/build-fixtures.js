/**
 * build-fixtures.js — deterministic SYNTHETIC fixtures for the offline suite.
 *
 * Privacy rule: NO real register content may live in this repo — not even
 * public-record data, because *which entities a tool records reveals whom
 * someone is investigating*. Fixtures reproduce the STRUCTURE observed in the
 * wild (transposed onto a fictional universe); the live tier (CRZ_LIVE=1) is
 * the only thing that touches reality, and it stores nothing.
 *
 * Fictional universe (consistent across fixtures and tests):
 *   supplier  F & G STAVBY s.r.o.        IČO 45678901  (& ⇒ §11 F5 variants case)
 *   renamed   X & Y Invest, spol. s r.o. IČO 45678901  (⇒ §11 F1 reverse direction)
 *   authority Doprava Podnik, a.s.       IČO 45678902
 *   authority Nemocnica VZOR, a.s.       IČO 45678903
 *   obec      VZOR                       IČO 00000001
 *   contracts 999999xx / legacy 9900047 / attachments 990000xx / XML ids 77000xx
 *
 * Usage: npm run fixtures   (regenerates test/fixtures/* from nothing)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { rowsHtml, detailHtml } from './synth.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const BASE = 'https://www.crz.gov.sk';
const SEARCH_ROOT = '/2171273-sk/centralny-register-zmluv/'; // site structure, not personal data

// ── ZIP writers (methods 0 + 8, as found in real CRZ archives) ──────────────
function makeZip(name, text, { deflate = true } = {}) {
    const body = Buffer.from(text, 'utf8');
    const comp = deflate ? zlib.deflateRawSync(body) : body;
    const method = deflate ? 8 : 0;
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(body) : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localPart = Buffer.concat([local, nameBuf, comp]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);
    const cd = Buffer.concat([central, nameBuf]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, cd, eocd]);
}

// ── shells ───────────────────────────────────────────────────────────────────
function searchFormHtml() {
    const opts = [['0', ' '], ['114495', 'Ministerstvo fiktívne SR'], ['114496', 'Ministerstvo dopravy VZOR'],
        ['114497', 'Úrad fiktívny SR'], ['114499', 'Doprava Podnik, a.s.'], ['114501', 'Univerzita VZOR v Bratislave']]
        .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    return `<html><head><meta name="generator" content="SysCom"></head><body>
    <strong>Celkovo zverejnených <span class="c">5973361</span> zmlúv</strong>
    <form class="form-inline input-group form-fulltext" action="${SEARCH_ROOT}" method="post">
        <input name="search" id="search-input"></form>
    <form id="frm_filter_3" action="${SEARCH_ROOT}" method="get" class="sc_frm">
        <input name="art_predmet" id="frm_filter_3_art_predmet">
        <input name="nazov"><input name="art_zs1"><input name="art_zs2">
        <input name="art_ico"><input name="art_ico1">
        <input name="art_suma_spolu_od"><input name="art_suma_spolu_do">
        <input name="art_datum_zverejnene_od"><input name="art_datum_zverejnene_do">
        <select name="art_rezort">${opts}</select>
        <input name="odoslat" type="submit"></form></body></html>`;
}

const ROWS = (start, n = 20, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({
    id: start + i,
    title: `Zmluva VZOR ${start + i}`,
    number: `VZ/${start + i}`,
    pub: `${(i % 28) + 1}. Október 2026`,
    amount: `${(((i * 7919) % 9000) + 100).toLocaleString('sk-SK').replace(/,/g, '.')}&nbsp;&euro;`,
    sup: i % 3 === 0 ? 'F & G STAVBY s.r.o.' : `Firma ${i} s.r.o.`,
    auth: i % 2 === 0 ? 'Doprava Podnik, a.s.' : 'Obec VZOR',
    ...extra(i),
}));

const page = (rows, opts = {}) => `<html><body><main><h1>Zmluvy</h1>${rowsHtml(rows, opts)}</main></body></html>`;

// amendments: 20 rows incl. ONE legacy bare-path row (§11-verified real shape)
const amendmentsRows = [
    { id: 9900047, title: 'Nájomná zmluva - pozemky VZOR', number: 'Nájomná zmluva č. 4 150-05 2019',
      legacy: true, status: 'Doplnená', sup: 'Pozemok VZOR', auth: 'Obec VZOR' },
    ...ROWS(99999930, 19, () => ({ status: 'Doplnená' })),
];

// ── detail fixtures ──────────────────────────────────────────────────────────
const detailBasic = detailHtml({
    id: 99999901,
    pairs: [
        ['Typ', 'Zmluva'], ['Č. zmluvy', 'VZ/2026-01'], ['Rezort', 'Ministerstvo fiktívne SR'],
        ['Objednávateľ', 'Obec VZOR<br/>Hlavna 1, 00001 VZOR'], ['IČO', '00000001'],
        ['Dodávateľ', 'Fiktívny Ján<br/>Hlavna 2, 00001 VZOR'],
        ['Názov zmluvy', 'Kúpna zmluva (Vzorka, Vzorková)'], ['ID zmluvy', '99999901'],
        ['Zverejnil', 'Obec VZOR'],
        ['Dátum zverejnenia', '30.10.2026'], ['Dátum uzavretia', '26.10.2026'],
        ['Dátum účinnosti', '31.10.2026'], ['Dátum platnosti do', 'neuvedený'],
    ],
    atts: [{ url: '/data/att/99000001.pdf', name: 'Kúpna zmluva (Vzorka, Vzorková)', ext: '.pdf', size: '10 kB' }],
});

const detailFull = detailHtml({
    id: 99999905,
    pairs: [
        ['Typ', 'Zmluva'], ['Č. zmluvy', 'VZ/2026-05'], ['Rezort', 'Úrad fiktívny SR'],
        ['Objednávateľ', 'Doprava Podnik, a.s.<br/>Metodova 8, 82108 Bratislava'], ['IČO', '45678902'],
        ['Dodávateľ', 'Slovenská republika zastúpená Úradom VZOR<br/>Pribinova 2, 81272 Bratislava'], ['IČO', '00000009'],
        ['Názov zmluvy', 'DOHODA o narovnaní nákladov VZ'], ['ID zmluvy', '99999905'],
        ['Dátum zverejnenia', '31.10.2026'], ['Dátum uzavretia', '28.10.2026'],
        ['Dátum účinnosti', 'deň nasledujúci po dni zverejnenia'], ['Dátum platnosti do', 'neuvedený'],
        ['Poznámka', 'Ďalší dodávatelia:\nVZOR REALITY a.s., Gorkého 8, Bratislava, IČO: 31111111, Mesto VZOR, IČO: 31111112'],
    ],
    atts: [{ url: '/data/att/99000002.pdf', name: 'DOHODA o narovnaní nákladov VZ', ext: '.pdf', size: '512 kB' }],
});

const detailIcoInName = detailHtml({
    id: 99999902,
    pairs: [
        ['Typ', 'Zmluva o dielo'], ['Rezort', 'Ministerstvo fiktívne SR'],
        ['Objednávateľ', 'Doprava Podnik, a.s.<br/>Metodova 8, 82108 Bratislava'], ['IČO', '45678902'],
        ['Dodávateľ', '"F & G STAVBY s.r.o. Stavebná 4 83104 Bratislava IČO: 45 678 901"'],
        ['Názov zmluvy', 'Zmluva o dielo VZ 4400/2026'], ['ID zmluvy', '99999902'],
    ],
    atts: [{ url: '/data/att/99000003.pdf', name: 'Zmluva o dielo', ext: '.pdf', size: '9 kB' }],
});

const detailIcoBlank = detailHtml({
    id: 99999903,
    pairs: [
        ['Typ', 'Rámcový dodávateľ'], ['Objednávateľ', 'Doprava Podnik, a.s.<br/>Metodova 8'], ['IČO', '45678902'],
        ['Dodávateľ', 'F & G STAVBY s.r.o.<br/>Stavebná 4, Bratislava'],
        ['Názov zmluvy', 'Rámcová dohoda VZ 0575/2026'], ['ID zmluvy', '99999903'],
    ],
    atts: [{ url: '/data/att/99000004.pdf', name: 'Ramcova dohoda', ext: '.pdf', size: '12 kB' }],
});

const detailNameChange = detailHtml({
    id: 99999904,
    pairs: [
        ['Typ', 'Zmluva'], ['Objednávateľ', 'Nemocnica VZOR, a.s.<br/>VZORova 24'], ['IČO', '45678903'],
        ['Dodávateľ', 'X & Y Invest, spol. s r.o.<br/>VZORova 24, 85101 Bratislava'], ['IČO', '45678901'],
        ['Názov zmluvy', 'Zmluva o dodávke VZ 12/2012'], ['ID zmluvy', '99999904'],
    ],
    atts: [{ url: '/data/att/99000005.pdf', name: 'Zmluva', ext: '.pdf', size: '8 kB' }],
});

// ── diff XML (structure from real nightly records, entities fictional) ──────
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<zmluvy>';
const diffRecords = `${XML_HEAD}<zmluva><nazov>Dodatok č.1 k zmluve č.27622 - vZOR dvor</nazov><ID>7700001</ID><zs1>Obec VZOR</zs1><zs2>ALFA STAV s.r.o.</zs2><predmet>Dodatok k zmluve o dielo č. 27622</predmet><datum_ucinnost>2022-11-17</datum_ucinnost><datum_platnost_do>0000-00-00</datum_platnost_do><suma_zmluva>212679.78</suma_zmluva><suma_spolu>212679.78</suma_spolu><id>46182</id><poznamka></poznamka><rezort>6215909</rezort><datum_zverejnene>2022-11-16 10:00:18</datum_zverejnene><ico>12345678</ico><stav>2</stav><potv_ziadost>1</potv_ziadost><potv_datum>0000-00-00</potv_datum><zdroj>3</zdroj><text_ucinnost></text_ucinnost><sidlo>SNP 711/15, Velky VZOR</sidlo><ico1>00000001</ico1><sidlo1>Zeleznicna 4/320, VZOR</sidlo1><potvrdenie></potvrdenie><typ>1</typ><datum>2022-11-15</datum><popis></popis><druh>2</druh><ref>https://www.vzor.example/crz/contract/43206</ref><internapozn></internapozn><popis_predmetu></popis_predmetu><poznamka_zmena></poznamka_zmena><uvo></uvo><crzid>7700001</crzid><changelog></changelog><chan>2022-11-16 10:00:18</chan><prilohy><priloha><ID>7700002</ID><nazov>dodatok_vzor_zverej</nazov><dokument></dokument><velkost>0</velkost><dokument1>99000111.pdf</dokument1><velkost1>0</velkost1><chan>2026-10-30 13:47:45</chan></priloha></prilohy></zmluva><zmluva><nazov>Zmluva VZ 2/2023</nazov><ID>7700003</ID><zs1>Obec VZOR</zs1><zs2>BETA ENERGY, a.s.</zs2><predmet>Zvyssenie energetickej ucinnosti</predmet><datum_ucinnost>2023-06-01</datum_ucinnost><datum_platnost_do>0000-00-00</datum_platnost_do><suma_zmluva>55000</suma_zmluva><suma_spolu>55000</suma_spolu><id>46999</id><rezort>6215909</rezort><datum_zverejnene>2023-06-02 08:00:00</datum_zverejnene><ico>87654321</ico><stav>2</stav><sidlo>Priemyselná 9, VZOR</sidlo><ico1>00000001</ico1><sidlo1>Zeleznicna 4/320, VZOR</sidlo1><typ>1</typ><datum>2023-05-30</datum><druh>2</druh><ref></ref><crzid>7700003</crzid><chan>2023-06-02 08:00:00</chan><prilohy></prilohy></zmluva></zmluvy>`;

const diffIcoBlank = `${XML_HEAD}<zmluva><nazov>VZ/2026</nazov><ID>99999903</ID><zs1>Doprava Podnik, a.s.</zs1><zs2>F &amp; G STAVBY s.r.o.</zs2><predmet>Rámcová zmluva č. 4600008607/PT/2026 - odpadové hospodárstvo</predmet><datum_ucinnost>2026-10-11</datum_ucinnost><datum_platnost_do>2027-10-10</datum_platnost_do><suma_zmluva>400000</suma_zmluva><suma_spolu>400000</suma_spolu><id>99001</id><rezort>6215909</rezort><datum_zverejnene>2026-10-10 14:22:00</datum_zverejnene><ico></ico><stav>2</stav><sidlo>Stavebná 4, Bratislava</sidlo><ico1>45678902</ico1><sidlo1>Metodova 8, Bratislava</sidlo1><typ>1</typ><datum>2026-10-08</datum><druh>2</druh><ref></ref><crzid>99999903</crzid><changelog></changelog><chan>2026-10-10 14:22:00</chan><prilohy><priloha><ID>99000123</ID><nazov>ramcova_zmluva</nazov><dokument1>99000123.pdf</dokument1><velkost1>253755</velkost1><chan>2026-10-10 14:22:00</chan></priloha></prilohy></zmluva></zmluvy>`;

const EMPTY_DIFF = '<?xml version="1.0" encoding="UTF-8"?>\n<zmluvy/>\n';

const rssItems = [
    ['Zmluva VZOR 99999921 (Cena: 12,60 EUR)', 'http://crz.gov.sk/zmluva/99999921/', 'Objednávateľ: Doprava Podnik, a.s., Dodávateľ: Fiktívny Ján', 'Fri, 30 Oct 2026 14:22:00 +0100'],
    ['Rámcová dohoda (Cena: 1 500,00 EUR)', 'http://crz.gov.sk/zmluva/99999922/', 'Objednávateľ: Obec VZOR, Dodávateľ: F & G STAVBY s.r.o.', 'Fri, 30 Oct 2026 13:00:00 +0100'],
    ['Zmluva o dielo VZ 3', 'http://crz.gov.sk/zmluva/99999923/', 'Objednávateľ: Univerzita VZOR, Dodávateľ: ALFA STAV s.r.o.', 'Fri, 30 Oct 2026 12:00:00 +0100'],
    ['Zmluva o nájme VZ 4', 'http://crz.gov.sk/zmluva/99999924/', 'Objednávateľ: Nemocnica VZOR, a.s., Dodávateľ: BETA ENERGY, a.s.', 'Fri, 30 Oct 2026 11:00:00 +0100'],
    ['Objednávka VZ 5 (Cena: 5 965,50 EUR)', 'http://crz.gov.sk/zmluva/99999925/', 'Objednávateľ: Úrad fiktívny SR, Dodávateľ: Gama Trade s.r.o.', 'Fri, 30 Oct 2026 10:00:00 +0100'],
    ['Dodatok č. 1 VZ 6', 'http://crz.gov.sk/zmluva/99999926/', 'Objednávateľ: Doprava Podnik, a.s., Dodávateľ: Delta IT, s.r.o.', 'Fri, 30 Oct 2026 09:00:00 +0100'],
];
const rss = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Centrálny register zmlúv</title><link>${BASE}/</link><description>synthetic feed fixture</description>${rssItems.map(([t, l, d, p]) => `<item><title>${t}</title><link>${l}</link><description>${d}</description><guid isPermaLink="false">${l}</guid><pubDate>${p}</pubDate></item>`).join('')}</channel></rss>`;

// ── manifest of what each fixture PROVES (structural, never real content) ───
const PURPOSES = {
    'form-zmluvy.html': 'frm_filter_3 form + action path + rezort select option ids',
    'list-recent-order.html': 'recent list rows with ?order=22&page=1 applied',
    'list-amendments.html': '20 supplement rows incl. ONE legacy bare /<id>/ link + Doplnená badge',
    'list-terminated.html': 'terminated list rows',
    'search-kupna.html': 'search page 0 with pager window (page=1..10 pattern)',
    'search-kupna-page1.html': 'same query page 1 — distinct ids for harvest chaining',
    'fulltext-koncert.html': 'fulltext GET result page shape',
    'party-space-amp.html': '0-row page from spaced-ampersand party query (§11 F5 false negative)',
    'party-glued.html': '20-row page from glued-ampersand variant (§11 F5 retry target)',
    'detail-basic.html': 'single-IČO detail; span/span + strong/strong amount variants',
    'detail-full.html': 'note field, two IČO labels (order-sensitive), kB-size attachment',
    'detail-ico-in-name.html': 'IČO ONLY inside quoted supplier name; one IČO label = authority (§11 F3)',
    'detail-ico-blank.html': 'supplier with NO IČO anywhere (§11 F1 forward direction)',
    'detail-name-change.html': 'same IČO under a different legal name (§11 F1 reverse direction)',
    'detail-missing.html': 'unknown id → 404 styled page',
    'feed-rss.xml': 'RSS item shape incl. price-in-title and comma-containing parties',
    'diff-sample.xml': 'two full nightly <zmluva> records (all tags incl. prilohy, 0000 sentinels)',
    'diff-ico-blank.xml': 'nightly record with empty <ico></ico> + filled <ico1> (§11 F2)',
    'diff-sample.zip': 'DEFLATE (method 8) archive — real nightly compression',
    'export-empty.zip': 'STORED (method 0) archive with empty <zmluvy/> — valid zero-event day',
};

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));

const text = {
    'form-zmluvy.html': searchFormHtml(),
    'list-recent-order.html': page(ROWS(99999960), { nextPage: 1 }),
    'list-amendments.html': page(amendmentsRows),
    'list-terminated.html': page(ROWS(99999980, 20, (i) => (i % 2 ? { status: 'Zrušená' } : {}))),
    'search-kupna.html': page(ROWS(99999000), { nextPage: 1 }),
    'search-kupna-page1.html': page(ROWS(99999100), { nextPage: 2 }),
    'fulltext-koncert.html': page(ROWS(99998000), { nextPage: 1 }),
    'party-space-amp.html': page([]),
    'party-glued.html': page(ROWS(99997000), { nextPage: 1 }),
    'detail-basic.html': detailBasic,
    'detail-full.html': detailFull,
    'detail-ico-in-name.html': detailIcoInName,
    'detail-ico-blank.html': detailIcoBlank,
    'detail-name-change.html': detailNameChange,
    'detail-missing.html': '<html><body><h1>404 — zmluva nenájdená</h1></body></html>',
    'feed-rss.xml': rss,
    'diff-sample.xml': diffRecords,
    'diff-ico-blank.xml': diffIcoBlank,
};
const binaries = {
    'diff-sample.zip': makeZip('2026-10-30.xml', diffRecords, { deflate: true }),
    'export-empty.zip': makeZip('2020-01-01.xml', EMPTY_DIFF, { deflate: false }),
};

const manifest = {};
for (const [name, content] of Object.entries(text)) {
    fs.writeFileSync(path.join(OUT, name), content);
    manifest[name] = { synthetic: true, bytes: Buffer.byteLength(content), purpose: PURPOSES[name] };
}
for (const [name, buf] of Object.entries(binaries)) {
    fs.writeFileSync(path.join(OUT, name), buf);
    manifest[name] = { synthetic: true, bytes: buf.length, purpose: PURPOSES[name] };
}
manifest._builtAt = new Date().toISOString().slice(0, 10);
manifest._note = '100% synthetic fictional universe; regenerate with `npm run fixtures`. Structure mirrors live reality; live tier (CRZ_LIVE=1) verifies against the site.';
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`fixtures built: ${Object.keys(text).length} text + ${Object.keys(binaries).length} zip → ${OUT}`);
