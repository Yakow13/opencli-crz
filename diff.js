/**
 * Pure ingest primitives for the CRZ nightly differential (Phase 2).
 * Zero dependencies: central-directory ZIP reader (methods 0 and 8 — both
 * occur in real CRZ archives) + tolerant diff-XML record parser.
 * Field semantics verified against recorded fixtures (see test/changes.test.js).
 */
import zlib from 'node:zlib';
import { BASE, decodeEntities } from './utils.js';

/** Read all entries of a ZIP buffer keyed by name. Throws on non-ZIP/unknown method. */
export function readZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory)');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compSize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`not a ZIP archive readable by crz (unsupported method ${method})`);
        entries.set(name, data);
        off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

const RECORD_TAGS = {
    nazov: 'title', predmet: 'subject', zs1: 'authority', zs2: 'supplier',
    sidlo1: 'authorityAddress', sidlo: 'supplierAddress',
    suma_zmluva: 'sumOriginal', suma_spolu: 'sumTotal',
    datum: 'closedAt', datum_zverejnene: 'publishedAt', datum_ucinnost: 'effectiveAt',
    datum_platnost_do: 'validUntil',
    stav: 'stav', typ: 'typ', druh: 'druh', zdroj: 'zdroj',
    rezort: 'rezortRaw', ref: 'sourceRef', chan: 'changeTs', poznamka: 'note',
};

const dateOnly = (s) => { // '2022-11-16 10:00:18' -> '2022-11-16T10:00:18'; '0000-00-00' -> null
    if (!s || /^0{4}-0{2}-0{2}/.test(s)) return null;
    const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/);
    if (!m) return null;
    return m[2] ? `${m[1]}T${m[2]}` : m[1];
};
const numOrNull = (s) => {
    if (s === null || s === '' || Number.isNaN(Number(s))) return null;
    return Number(s);
};
const textOrNull = (s) => (s && s.length ? s : null);

/** Parse one <zmluva> block (prilohy excluded first so <ID>/<nazov> stay unambiguous).
 * Tag regexes demand EXACT names: <chan> must not match <changelog>, <datum> not <datum_ucinnost>. */
function parseRecord(block) {
    const prilohy = block.match(/<prilohy>[\s\S]*?<\/prilohy>/)?.[0] ?? '';
    const top = block.replace(/<prilohy>[\s\S]*?<\/prilohy>/g, '');
    const field = (tag) => {
        const m = top.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
        return m ? decodeEntities(m[1]).trim() : undefined;
    };
    const ev = {};
    for (const [tag, key] of Object.entries(RECORD_TAGS)) {
        let v = field(tag);
        if (v === undefined) { ev[key] = null; continue; }
        if (key === 'sumOriginal' || key === 'sumTotal') v = numOrNull(v === '' ? null : v);
        else if (['closedAt', 'publishedAt', 'effectiveAt', 'validUntil'].includes(key)) v = dateOnly(v);
        else v = textOrNull(v);
        ev[key] = v;
    }
    ev.crzid = numOrNull(field('crzid') || field('ID') || null);
    ev.legacyId = numOrNull(field('id') ?? null); // <id> = old-system row id (different space!)
    ev.number = textOrNull(field('cislo') ?? null);
    const icoTag = (tag) => {
        const m = top.match(new RegExp(`<${tag}>((?:[\\s\\S]*?))</${tag}>`));
        if (!m) return 'absent';
        const digits = m[1].replace(/\D/g, '');
        return { state: digits ? 'present' : 'blank', digits: digits || null };
    };
    const sup = icoTag('ico'); const aut = icoTag('ico1');
    ev.supplierIco = typeof sup === 'object' ? sup.digits : null;
    ev.authorityIco = typeof aut === 'object' ? aut.digits : null;
    ev.icoSourceFlag = typeof sup === 'object' ? sup.state : 'absent';   // supplier side provenance
    ev.authorityIcoFlag = typeof aut === 'object' ? aut.state : 'absent';
    ev.kind = /^(dodat|zmenu van|vypoved)/i.test(ev.title ?? ev.subject ?? '') ? 'amendment' : 'contract';
    ev.attachments = [];
    for (const a of prilohy.matchAll(/<priloha>([\s\S]*?)<\/priloha>/g)) {
        const f = (tag) => {
            const m = a[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
            return m ? decodeEntities(m[1]).trim() : '';
        };
        const file = f('dokument1') || f('dokument');
        ev.attachments.push({
            attId: numOrNull(f('ID')) ?? null,
            name: textOrNull(f('nazov')),
            file: textOrNull(file),
            url: file ? `${BASE}/data/att/${file}` : null,
            bytes: numOrNull(f('velkost1') || f('velkost') || '0') ?? 0,
            changedAt: textOrNull(f('chan')),
        });
    }
    return ev;
}

/** Whole diff document -> normalized event rows. Tolerant: unpaired/garbage blocks never throw. */
export function parseDiffXml(xml) {
    const events = [];
    for (const m of String(xml).matchAll(/<zmluva>([\s\S]*?)<\/zmluva>/g)) {
        try {
            events.push(parseRecord(m[0]));
        } catch { /* skip pathological records; never lose the whole day to one row */ }
    }
    return events;
}
