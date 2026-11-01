/**
 * Shared helpers for the crz.* adapters (Centrálny register zmlúv, www.crz.gov.sk).
 *
 * The site is a SysCom CMS with server-rendered HTML tables (20 rows/page).
 * Two entry points matter:
 *   - list pages  /zmluvy/, /doplnene-zmluvy/, /zrusene-zmluvy/  (?page=N, 0-based)
 *   - search      <form id="frm_filter_3" action>               (numbered CMS path,
 *                 resolved at runtime from /zmluvy/, with a constant fallback)
 * Detail pages live at /zmluva/<id>/ and expose <strong>label:</strong><span>value</span>
 * pairs plus attachment links under /data/att/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';

export const BASE = 'https://www.crz.gov.sk';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';
/** Known-good SysCom root for the contract search form; re-discovered on demand. */
export const FALLBACK_SEARCH_PATH = '/2171273-sk/centralny-register-zmluv/';

const NAMED_ENTITIES = {
    nbsp: '\u00a0', euro: '\u20ac', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019',
    ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', bull: '\u2022',
    aacute: 'á', ae: 'ä', ccaron: 'č', dcaron: 'ď', eacute: 'é', iacute: 'í', lacute: 'ĺ',
    lcaron: 'ľ', nacute: 'ń', ncaron: 'ň', oacute: 'ó', ocirc: 'ô', rcaron: 'ŕ', sacute: 'š',
    scaron: 'š', tcaron: 'ť', uacute: 'ú', yacute: 'ý', zacute: 'ž', zcaron: 'ž',
    Aacute: 'Á', AEmacron: 'Ä', Ccaron: 'Č', Dcaron: 'Ď', Eacute: 'É', Iacute: 'Í',
    Lacute: 'Ĺ', Lcaron: 'Ľ', Nacute: 'Ń', Ncaron: 'Ň', Oacute: 'Ó', Ocire: 'Ô',
    Rcaron: 'Ŕ', Sacute: 'Š', Scaron: 'Š', Tcaron: 'Ť', Uacute: 'Ú', Yacute: 'Ý',
    Zacute: 'Ž', Zcaron: 'Ž',
};

export function decodeEntities(input) {
    return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ref) => {
        if (ref[0] === '#') {
            const code = ref[1] === 'x' || ref[1] === 'X'
                ? parseInt(ref.slice(2), 16)
                : parseInt(ref.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : m;
    });
}

/** HTML fragment -> readable text (block breaks kept as \n). */
export function htmlToText(html) {
    const withBreaks = String(html)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|p|li|tr|td|span|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeEntities(withBreaks)
        .replace(/[ \t\u00a0]+/g, ' ')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n');
}

// ── Local cache (agent runs re-query the same pages constantly; CRZ asks
//    crawlers to be polite — see /stahovanie-udajov-z-crz/) ──────────────────
const CACHE_DIR = path.join(os.homedir(), '.opencli', 'cache', 'crz');
export const TTL_SEARCH = 10 * 60_000; // lists & search results
export const TTL_DETAIL = 24 * 3_600_000; // per-contract pages (content is immutable once published,
                                          // except supplements — re-check daily at most)
export const TTL_FEED = 60_000;

const cacheDisabled = () => process.env.OPENCLI_CRZ_CACHE === '0';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheFile(url) {
    return path.join(CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + '.json');
}

async function readCache(url, ttlMs) {
    if (cacheDisabled() || ttlMs <= 0) return null;
    try {
        const file = cacheFile(url);
        const [stat, body] = await Promise.all([fs.stat(file), fs.readFile(file, 'utf8')]);
        if (Date.now() - stat.mtimeMs > ttlMs) return null;
        const entry = JSON.parse(body);
        return entry?.url === url && typeof entry.text === 'string' ? entry.text : null;
    } catch {
        return null;
    }
}

async function writeCache(url, text) {
    if (cacheDisabled()) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        await fs.writeFile(cacheFile(url), JSON.stringify({ url, savedAt: new Date().toISOString(), text }));
    } catch { /* cache must never break a command */ }
}

export async function fetchText(url, { referer, fresh = false, ttlMs = TTL_SEARCH } = {}) {
    if (!fresh) {
        const hit = await readCache(url, ttlMs);
        if (hit !== null) return hit;
    }
    const headers = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' };
    if (referer) headers.Referer = referer;
    let resp;
    try {
        resp = await fetch(url, { headers, redirect: 'follow' });
    } catch (e) {
        throw new CommandExecutionError(`Cannot reach ${url}: ${e.message}`, 'CRZ undergoes weekend maintenance — try again later.');
    }
    if (resp.status === 500) {
        throw new CommandExecutionError('crz.gov.sk returned HTTP 500', 'Planned maintenance windows run on weekends; retry later or check https://www.crz.gov.sk/technicka-podpora/');
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`crz.gov.sk returned HTTP ${resp.status} for ${url}`);
    }
    const text = await resp.text();
    await writeCache(url, text);
    return text;
}

export async function fetchBytes(url, { referer } = {}) {
    const headers = { 'User-Agent': UA };
    if (referer) headers.Referer = referer;
    let resp;
    try {
        resp = await fetch(url, { headers, redirect: 'follow' });
    } catch (e) {
        throw new CommandExecutionError(`Cannot download ${url}: ${e.message}`);
    }
    if (resp.status === 404) {
        throw new CommandExecutionError(`Not found (HTTP 404): ${url}`, 'Daily differential files exist only for past days and are generated around 02:00.');
    }
    if (!resp.ok) throw new CommandExecutionError(`Download failed: HTTP ${resp.status} for ${url}`);
    return Buffer.from(await resp.arrayBuffer());
}

// ── Dates & amounts ──────────────────────────────────────────────────────────
const MONTHS = {
    januara: 1, januar: 1, jan: 1, february: 2, februar: 2, februara: 2, feb: 2, marec: 3, marca: 3, marc: 3, mar: 3,
    aprila: 4, april: 4, apr: 4, maja: 5, maj: 5, jun: 6, juna: 6, jul: 7, jula: 7,
    augusta: 8, august: 8, aug: 8, septembra: 9, september: 9, sep: 9, sept: 9,
    oktobra: 10, oktober: 10, okt: 10, novembra: 11, november: 11, nov: 11,
    decembra: 12, december: 12, dec: 12,
};

/** "30. Október 2026" / "30.10.2026" -> ISO yyyy-mm-dd (null when unparseable). */
export function parseSlovakDate(text) {
    if (!text) return null;
    const t = normalizeDiacritics(String(text).replace(/[ \u00a0]+/g, ' ').trim());
    const iso = (y, mo, d) => {
        const n = [Number(y), Number(mo), Number(d)];
        if (n[1] < 1 || n[1] > 12 || n[2] < 1 || n[2] > 31) return null;
        return `${n[0]}-${String(n[1]).padStart(2, '0')}-${String(n[2]).padStart(2, '0')}`;
    };
    let m = t.match(/(\d{1,2})\.\s*([a-záčďéíľĺňóôŕšťúýž]+)\.?\s*(\d{4})/);
    if (m) {
        const month = MONTHS[m[2]];
        if (month) return iso(m[3], month, m[1]);
    }
    m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return iso(m[3], m[2], m[1]);
    m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return iso(m[1], m[2], m[3]);
    return null;
}

export function normalizeDiacritics(text) {
    return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** "1 918 766,54 €" -> { value: 1918766.54, raw: "1 918 766,54 €" } */
export function parseAmount(text) {
    const raw = String(text ?? '').replace(/\n/g, ' ').trim();
    const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/\s/g, '');
    if (!cleaned) return { value: null, raw };
    let candidate = cleaned;
    if (candidate.includes(',')) {
        // thousands are spaced in CRZ output; the comma is the decimal separator
        candidate = candidate.replace(/\./g, '').replace(',', '.');
    } else if ((candidate.match(/\./g) || []).length > 1) {
        candidate = candidate.replace(/\.(?=\d{3}(\D|$))/g, '');
    }
    const value = Number.parseFloat(candidate);
    return { value: Number.isFinite(value) ? value : null, raw };
}

/** CLI input (yyyy-mm-dd or dd.mm.yyyy) -> CRZ input dd.MM.yyyy. */
export function toSiteDate(input, label) {
    const iso = parseSlovakDate(input);
    if (!iso) throw new ArgumentError(`Invalid ${label}: "${input}" (expected yyyy-mm-dd or dd.mm.yyyy)`);
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

// ── List pages & search ──────────────────────────────────────────────────────
const ROW_RE = new RegExp(
    '<td class="cell1[^"]*">([\\s\\S]*?)</td>\\s*'
    + '<td class="cell2[^"]*">([\\s\\S]*?)</td>\\s*'
    + '<td class="cell3[^"]*">([\\s\\S]*?)</td>\\s*'
    + '<td class="cell4[^"]*">([\\s\\S]*?)</td>\\s*'
    + '<td class="cell5[^"]*">([\\s\\S]*?)</td>',
    'g');

/** strip separators, lowercase, remove diacritics — for tolerant name/number compares */
export function normKey(s) {
    return normalizeDiacritics(String(s ?? '')).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Retry ladder for the site's brittle party LIKE (§11 F5: `F & G` → 0 rows, `F&G` → 20). */
export function partyVariants(name) {
    const seen = new Set();
    const out = [];
    const push = (s) => {
        s = String(s).replace(/\s+/g, ' ').trim();
        const k = s.toLowerCase();
        if (s && !seen.has(k)) { seen.add(k); out.push(s); }
    };
    push(name);
    push(String(name).replace(/\s*&\s*/g, '&'));      // glue the ampersand token
    push(String(name).replace(/\s*&\s*/g, ' and '));  // spell it out
    push(String(name).replace(/&/g, ' '));            // drop it entirely
    return out;
}

/**
 * Page-state metadata so agents never answer from a silent slice (§11 F6).
 * pageCount is EXACT only when the pager says this was the last page —
 * otherwise null (never guessed); pageWindowMax is the honest lower bound
 * derived from the rendered bootstrap pager.
 */
export function derivePageState(html, page, rowCount) {
    const zeroIdx = [...html.matchAll(/page=(\d+)/g)].map((m) => Number(m[1]));
    const displays = [...html.matchAll(/Str[aá]nka (\d+)/g)].map((m) => Number(m[1]));
    const pageWindowMax = Math.max(zeroIdx.length ? Math.max(...zeroIdx) + 1 : 0,
        displays.length ? Math.max(...displays) : 0);
    const hasMore = hasMorePages(html, page, rowCount);
    return { hasMore, pageCount: hasMore ? null : page + 1, pageWindowMax };
}

export function parseRows(html) {
    const rows = [];
    for (const m of html.matchAll(ROW_RE)) {
        // canonical /zmluva/<id>/ and legacy bare /<id>/ detail links (older contracts)
        const linkMatch = m[2].match(/<a\s+href="(\/(?:zmluva\/)?\d{5,}\/?)"[^>]*>([\s\S]*?)<\/a>/);
        if (!linkMatch) continue;
        const id = linkMatch[1].match(/\d{5,}/)[0];
        const spans = [...m[2].matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((s) => htmlToText(s[1]).replace(/\n/g, ' '));
        const status = spans.find((s) => /doplnen|zru[šs]en/i.test(s)) ?? null;
        const publishedText = htmlToText(m[1]).replace(/\n/g, ' ');
        const amount = parseAmount(htmlToText(m[3]).replace(/\n/g, ' '));
        rows.push({
            id: Number(id),
            title: htmlToText(linkMatch[2]).replace(/\n/g, ' '),
            number: spans.find((s) => s && s !== status) ?? '',
            status,
            numberEcho: spans.length > 0
                && !!spans.find((s) => s && s !== status)
                && normKey(spans.find((s) => s && s !== status)) === normKey(htmlToText(linkMatch[2])),
            amountStated: amount.value != null && amount.value > 0, // 0,00 = unpriced ceiling convention (§11 F8)
            publishedAt: parseSlovakDate(publishedText),
            publishedRaw: publishedText,
            amount: amount.value,
            amountRaw: amount.raw,
            supplier: htmlToText(m[4]).replace(/\n/g, ' '),
            authority: htmlToText(m[5]).replace(/\n/g, ' '),
            url: linkMatch[1].startsWith('/zmluva/') ? `${BASE}/zmluva/${id}/` : `${BASE}/${id}/`,
        });
    }
    return rows;
}

export function hasMorePages(html, page, rowCount) {
    if (new RegExp(`[?&]page=${page + 1}\\b`).test(html)) return true;
    return rowCount === 20; // CRZ pages always render 20 rows when full
}

export async function fetchListPage(pathname, { page = 0, fresh = false } = {}) {
    const url = `${BASE}${pathname}${page > 0 ? `${pathname.includes('?') ? '&' : '?'}page=${page}` : ''}`;
    const html = await fetchText(url, { fresh });
    const rows = parseRows(html);
    if (!rows.length) {
        throw new EmptyResultError(`No contracts listed on ${pathname} page ${page}`, 'The list may be empty today or the site layout changed.');
    }
    return { page, hasMore: hasMorePages(html, page, rows.length), rows };
}

let searchPathCache;
/** Discover the SysCom search path from the filter form on /zmluvy/. */
export async function resolveSearchPath() {
    if (searchPathCache) return searchPathCache;
    const html = await fetchText(`${BASE}/zmluvy/`);
    const form = html.match(/<form[^>]*id="frm_filter_3"[^>]*>/i);
    const action = form && form[0].match(/action="([^"]+)"/);
    searchPathCache = action ? action[1] : FALLBACK_SEARCH_PATH;
    return searchPathCache;
}

let resortCache;
export async function resortOptions() {
    if (resortCache) return resortCache;
    const html = await fetchText(`${BASE}/zmluvy/`);
    const sel = html.match(/<select[^>]*name="art_rezort"[\s\S]*?<\/select>/);
    const opts = [];
    if (sel) {
        for (const m of sel[0].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
            if (m[1] && m[1] !== '0') opts.push({ value: m[1], label: decodeEntities(m[2]).trim() });
        }
    }
    resortCache = opts;
    return opts;
}

export async function matchResort(input) {
    const trimmed = String(input).trim();
    if (/^\d+$/.test(trimmed) && trimmed !== '0') return trimmed; // raw option id
    const options = await resortOptions();
    const needle = normalizeDiacritics(trimmed);
    const exact = options.find((o) => normalizeDiacritics(o.label) === needle);
    if (exact) return exact.value;
    const partial = options.filter((o) => normalizeDiacritics(o.label).includes(needle));
    if (partial.length === 1) return partial[0].value;
    if (partial.length > 1) {
        throw new ArgumentError(`Ambiguous resort "${trimmed}"`,
            `Matches: ${partial.slice(0, 8).map((o) => o.label).join(' | ')}${partial.length > 8 ? ' …' : ''}`);
    }
    throw new ArgumentError(`Unknown resort "${trimmed}"`,
        `Use a numeric resort id or one of ${options.length} labels shown at https://www.crz.gov.sk/zmluvy/ (e.g. "Ministerstvo fiktívne SR").`);
}

export function contractId(idArg) {
    const m = String(idArg ?? '').match(/(?:^|\/)(\d{5,})(?:\/|$)/);
    if (!m) throw new ArgumentError(`Invalid contract id "${idArg}"`, 'Pass the numeric CRZ id or a /zmluva/<id>/ URL.');
    return m[1];
}

// ── Detail pages ─────────────────────────────────────────────────────────────
export async function fetchContract(id, { fresh = false } = {}) {
    // post-2011 contracts live under /zmluva/<id>/; legacy ones under /<id>/ only
    try {
        var html = await fetchText(`${BASE}/zmluva/${id}/`, { fresh, ttlMs: TTL_DETAIL });
    } catch (e) {
        if (!/HTTP 404/.test(e.message)) throw e;
        html = await fetchText(`${BASE}/${id}/`, { fresh, ttlMs: TTL_DETAIL });
    }
    if (!html.includes('ID zmluvy') && !/\/zmluva\/\d+/.test(html)) {
        throw new CommandExecutionError(`Contract ${id} page did not contain expected detail markup`, 'Verify the id on https://www.crz.gov.sk/zmluvy/');
    }
    return html;
}

const FIELD_MAP = { // keys compared after normalizeDiacritics()
    typ: 'type',
    'c. zmluvy': 'number',
    rezort: 'rezort',
    objednavatel: 'authority',
    dodavatel: 'supplier',
    'ico': 'ico',
    'nazov zmluvy': 'title',
    'id zmluvy': 'contractId',
    zverejnil: 'publishedBy',
    'datum zverejnenia': 'publishedAt',
    'datum uzavretia': 'closedAt',
    'datum ucinnosti': 'effectiveAt',
    'datum platnosti do': 'validUntil',
    'zmluvne dohodnuta ciastka': 'agreedAmount',
    'celkova ciastka': 'totalAmount',
    'predmet plnenia': 'subject',
    poznamka: 'note',
};

export function parseDetail(html) {
    const pairs = [];
    const re = /<strong[^>]*>([^<]*?):<\/strong>\s*<span[^>]*>([\s\S]*?)<\/span>/g;
    for (const m of html.matchAll(re)) {
        const label = htmlToText(m[1]).replace(/:$/, '').trim();
        if (!label) continue;
        pairs.push({ label, value: htmlToText(m[2]) });
    }
    const detail = { id: null, url: null };
    const icoAssign = {}, icoSource = {};
    let currentPartyRole = null;
    for (const { label, value } of pairs) {
        const key = FIELD_MAP[normalizeDiacritics(label)] ?? FIELD_MAP[label.toLowerCase()];
        if (key === 'ico' || label === 'IČO') {
            // §11 F4: attribute by the party block we are inside, not by render order
            const role = currentPartyRole ?? (icoAssign.authority ? 'supplier' : 'authority');
            if (!icoAssign[role]) {
                icoAssign[role] = String(value).replace(/\D/g, '') || null;
                icoSource[role] = 'form';
            }
            continue;
        }
        if (key === 'authority' || key === 'supplier') currentPartyRole = key;
        if (!key) {
            (detail.extra ??= {})[label] = value;
            continue;
        }
        if (key in detail && key !== 'subject') detail.extra = { ...(detail.extra ?? {}), [label]: value };
        else detail[key] = value;
    }
    // §11 F3: some pages publish the IČO only INSIDE the party name string
    const NAME_ICO_RE = /I\s*[ČCc]\s*[OÓ]\s*[:–\-]?\s*(\d[\d\s]{5,14}\d)/;
    for (const role of ['authority', 'supplier']) {
        const text = detail[role];
        if (typeof text !== 'string') continue;
        if (!icoAssign[role]) {
            const m = text.match(NAME_ICO_RE);
            const digits = m ? m[1].replace(/\D/g, '') : null;
            if (digits && digits.length >= 7 && digits.length <= 9) {
                icoAssign[role] = digits;
                icoSource[role] = 'name-field';
            }
        }
    }
    detail.parties = [];
    for (const role of ['authority', 'supplier']) {
        const raw0 = typeof detail[role] === 'string' ? detail[role] : null;
        if (!raw0) continue;
        // site quotes the block when IČO is embedded; trailing "IČO: …" segment now lives in .ico
        const raw = raw0.replace(/^["']|["']$/g, '')
            .replace(/[,;]?\s*I\s*[ČCc]\s*[OÓ]\s*[:–\-]?\s*\d[\d\s/]*\d\s*[.,]?\s*$/u, '').trim();
        const [name, ...rest] = raw.split('\n');
        detail.parties.push({
            role,
            name: name.trim(),
            address: rest.join(', ').trim() || null,
            ico: icoAssign[role] ?? null,
            icoSource: icoSource[role] ?? null,
        });
    }
    if (detail.parties.length) {
        const q = (r) => detail.parties.find((p) => p.role === r);
        if (q('authority')?.ico) detail.authorityIco = q('authority').ico;
        if (q('supplier')?.ico) detail.supplierIco = q('supplier').ico;
        detail.icoSource = {
            authority: q('authority')?.icoSource ?? null,
            supplier: q('supplier')?.icoSource ?? null,
        };
    }
    detail.id = Number(detail.contractId) || Number(html.match(/\/zmluva\/(\d+)/)?.[1]) || null;
    detail.url = detail.id ? `${BASE}/zmluva/${detail.id}/` : null;
    for (const k of ['publishedAt', 'closedAt', 'effectiveAt', 'validUntil']) {
        if (detail[k]) {
            detail[k + 'Date'] = parseSlovakDate(detail[k]);
        }
    }
    if (detail.validUntilDate) detail.validUntil = detail.validUntilDate;
    // Cenové plnenie renders outside the strong/span grid (span/span or strong/strong pairs)
    const looseAmount = (labelRe) => {
        const m = html.match(labelRe);
        return m ? htmlToText(m[2]).replace(/\n/g, ' ').trim() : null;
    };
    if (!detail.agreedAmount) detail.agreedAmount = looseAmount(/Zmluvne dohodnut[áa]\s*[čc]iastka:\s*<\/[a-z]+>\s*<([a-z]+)[^>]*>([\s\S]*?)<\/\1>/);
    if (!detail.totalAmount) detail.totalAmount = looseAmount(/Celkov[áa]\s*[čc]iastka:\s*<\/[a-z]+>\s*<([a-z]+)[^>]*>([\s\S]*?)<\/\1>/);
    for (const k of ['agreedAmount', 'totalAmount']) {
        const parsed = parseAmount(detail[k] ?? '');
        detail[k] = parsed.value;
        detail[k + 'Raw'] = parsed.raw;
    }
    const attachments = [];
    const attRe = /<a[^>]*href="(\/data\/att\/[^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,200}?)<\/(?:li|td|tr|div)>/g;
    for (const m of html.matchAll(attRe)) {
        const metaMatch = htmlToText(m[3]).match(/\(\s*(\.[\w\d]+)\s*,\s*([^)]+)\)/);
        const name = htmlToText(m[2]).replace(/\n/g, ' ').trim();
        if (attachments.some((a) => a.url === BASE + m[1])) continue;
        attachments.push({
            name,
            url: BASE + m[1],
            ext: metaMatch ? metaMatch[1].slice(1) : m[1].split('.').pop(),
            sizeText: metaMatch ? metaMatch[2].trim() : null,
        });
    }
    detail.attachments = attachments;
    return detail;
}

// ── Shared search construction + polite multi-page harvest ──────────────────
export async function searchQueryParams(args, { fulltext = false } = {}) {
    const params = new URLSearchParams({ odoslat: '1' });
    const set = (key, value) => {
        const v = String(value ?? '').trim();
        if (v) params.set(key, v);
    };
    if (fulltext) {
        set('search', args.query); // site fulltext: title + subject + notes text
        return params;
    }
    set('art_predmet', args.query);           // Názov zmluvy
    set('nazov', args.number);                // Číslo zmluvy
    set('art_zs2', args.supplier);            // Dodávateľ
    set('art_ico', args['supplier-ico']);     // IČO dodávateľa
    set('art_zs1', args.authority);           // Objednávateľ
    set('art_ico1', args['authority-ico']);   // IČO objednávateľa
    if (args['min-amount'] != null) params.set('art_suma_spolu_od', String(args['min-amount']));
    if (args['max-amount'] != null) params.set('art_suma_spolu_do', String(args['max-amount']));
    if (args['published-from']) params.set('art_datum_zverejnene_od', toSiteDate(args['published-from'], 'published-from'));
    if (args['published-to']) params.set('art_datum_zverejnene_do', toSiteDate(args['published-to'], 'published-to'));
    if (args.rezort) params.set('art_rezort', await matchResort(args.rezort));
    return params;
}

/**
 * Walk search pages until exhausted / capped, sleeping between requests
 * (CRZ asks bulk consumers to be gentle; see /stahovanie-udajov-z-crz/).
 */
export async function harvest(params, { maxPages = 25, delayMs = 1400, capRows = 5000, fresh = false } = {}) {
    const path = await resolveSearchPath();
    const seen = new Set();
    const rows = [];
    let pages = 0;
    let stop = 'max-pages';
    for (let page = 0; page < maxPages; page++) {
        const qs = new URLSearchParams(params);
        if (page > 0) qs.set('page', String(page));
        const html = await fetchText(`${BASE}${path}?${qs.toString()}`, { referer: `${BASE}/zmluvy/`, fresh });
        const pageRows = parseRows(html);
        pages += 1;
        for (const r of pageRows) {
            if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
        }
        if (rows.length >= capRows) { stop = 'row-cap'; break; }
        if (pageRows.length < 20 || !hasMorePages(html, page, pageRows.length)) { stop = 'last-page'; break; }
        if (page + 1 < maxPages) await sleep(delayMs + Math.floor(Math.random() * 600));
    }
    return { rows, pages, stop };
}
