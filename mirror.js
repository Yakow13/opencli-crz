/**
 * SQLite mirror core (Phase 2 / M2): schema, upsert semantics, connection.
 * Engine: node:sqlite — built-in, verified unflagged on Node 22.19 (2026-11-01).
 *
 * Upsert semantics (§11 F2, PLAN §3.2):
 *  - contracts hold LATEST KNOWN state per crzid: a row only advances when its
 *    change_ts is newer, and NULL fields never blank out previously known values
 *    (COALESCE) — later diff records are partial by design.
 *  - IČO provenance is preserved: blank-at-source stays NULL + ico_source_flag.
 *  - aliases register (normalized name, ico, address) per contract — the seed
 *    for the entity resolution layer that ORSR/PDF will feed (M3/M4).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { normKey } from './utils.js';

export const DEFAULT_DB = path.join(os.homedir(), '.opencli', 'data', 'crz', 'mirror.sqlite');

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contracts(
  crzid INTEGER PRIMARY KEY, kind TEXT, title TEXT, subject TEXT,
  authority TEXT, supplier TEXT, authority_ico TEXT, supplier_ico TEXT,
  authority_address TEXT, supplier_address TEXT,
  sum_original REAL, sum_total REAL,
  closed_at TEXT, published_at TEXT, effective_at TEXT, valid_until TEXT,
  rezort_raw TEXT, stav TEXT, legacy_id INTEGER, source_ref TEXT,
  change_ts TEXT, ico_source_flag TEXT);
CREATE TABLE IF NOT EXISTS events(
  day TEXT NOT NULL, crzid INTEGER NOT NULL, chan TEXT NOT NULL, kind TEXT,
  PRIMARY KEY(day, crzid, chan));
CREATE TABLE IF NOT EXISTS attachments(
  att_id INTEGER PRIMARY KEY, crzid INTEGER, name TEXT, file TEXT, url TEXT, bytes INTEGER);
CREATE TABLE IF NOT EXISTS aliases(
  name_norm TEXT NOT NULL, ico TEXT NOT NULL DEFAULT '', address_norm TEXT NOT NULL DEFAULT '',
  crzid INTEGER NOT NULL, role TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'submitted',
  PRIMARY KEY(name_norm, ico, crzid, role));
CREATE INDEX IF NOT EXISTS idx_aliases_ico ON aliases(ico);
CREATE INDEX IF NOT EXISTS idx_contracts_supplier_ico ON contracts(supplier_ico);
CREATE INDEX IF NOT EXISTS idx_contracts_authority_ico ON contracts(authority_ico);
CREATE INDEX IF NOT EXISTS idx_contracts_published_at ON contracts(published_at);
CREATE INDEX IF NOT EXISTS idx_contracts_closed_at ON contracts(closed_at);
`;

export async function openMirror(dbPath = DEFAULT_DB, { mustExist = false, readOnly = false } = {}) {
    // node:sqlite is Node ≥22.5; load lazily so the rest of the suite (and entity
    // site mode) keeps working on older Node — OpenCLI itself supports ≥20.18.
    let DatabaseSync;
    try {
        ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
        throw new CommandExecutionError('The CRZ mirror needs Node.js 22.5+ (built-in node:sqlite).',
            'Upgrade Node (install.sh/install.ps1 do this), or keep using the non-mirror commands — search, detail, entity site mode, collect, evidence all work on Node 20.');
    }
    if (mustExist && !fs.existsSync(dbPath)) {
        throw Object.assign(new Error(`Mirror database does not exist yet: ${dbPath}`),
            { hint: 'Run `opencli crz sync --since <yyyy-mm-dd>` first.' });
    }
    if (!readOnly) fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
    if (!readOnly) {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(SCHEMA);
    }
    return db;
}

const CONTRACT_COLS = [
    'crzid', 'kind', 'title', 'subject', 'authority', 'supplier', 'authority_ico', 'supplier_ico',
    'authority_address', 'supplier_address', 'sum_original', 'sum_total', 'closed_at',
    'published_at', 'effective_at', 'valid_until', 'rezort_raw', 'stav', 'legacy_id',
    'source_ref', 'change_ts', 'ico_source_flag',
];

const EVENT_TO_COL = {
    crzid: 'crzid', kind: 'kind', title: 'title', subject: 'subject',
    authority: 'authority', supplier: 'supplier', authorityIco: 'authority_ico', supplierIco: 'supplier_ico',
    authorityAddress: 'authority_address', supplierAddress: 'supplier_address',
    sumOriginal: 'sum_original', sumTotal: 'sum_total', closedAt: 'closed_at',
    publishedAt: 'published_at', effectiveAt: 'effective_at', validUntil: 'valid_until',
    rezortRaw: 'rezort_raw', stav: 'stav', legacyId: 'legacy_id', sourceRef: 'source_ref',
    changeTs: 'change_ts', icoSourceFlag: 'ico_source_flag',
};

/** Insert one normalized diff event; returns true when it touched a contract row. */
export function upsertEvent(db, day, ev) {
    if (ev.crzid === null || ev.crzid === undefined) return false;
    const vals = CONTRACT_COLS.map((c) => {
        const src = Object.keys(EVENT_TO_COL).find((k) => EVENT_TO_COL[k] === c);
        const v = ev[src];
        return v === undefined || v === null ? null : (typeof v === 'object' ? String(v) : v);
    });
    const placeholders = CONTRACT_COLS.map(() => '?').join(', ');
    const updates = CONTRACT_COLS.filter((c) => c !== 'crzid')
        .map((c) => `${c} = COALESCE(excluded.${c}, ${c})`).join(', ');
    db.prepare(
        `INSERT INTO contracts(${CONTRACT_COLS.join(', ')}) VALUES(${placeholders})
         ON CONFLICT(crzid) DO UPDATE SET ${updates}
         WHERE excluded.change_ts >= contracts.change_ts OR contracts.change_ts IS NULL`
    ).run(...vals);
    db.prepare('INSERT OR IGNORE INTO events(day, crzid, chan, kind) VALUES(?, ?, ?, ?)')
        .run(day, ev.crzid, ev.changeTs ?? '', ev.kind ?? null);
    for (const a of ev.attachments ?? []) {
        if (a.attId !== null && a.attId !== undefined) {
            db.prepare('INSERT OR IGNORE INTO attachments(att_id, crzid, name, file, url, bytes) VALUES(?,?,?,?,?,?)')
                .run(a.attId, ev.crzid, a.name, a.file, a.url, a.bytes);
        }
    }
    for (const [role, name, ico, addr] of [
        ['supplier', ev.supplier, ev.supplierIco, ev.supplierAddress],
        ['authority', ev.authority, ev.authorityIco, ev.authorityAddress],
    ]) {
        if (!name) continue;
        db.prepare('INSERT OR IGNORE INTO aliases(name_norm, ico, address_norm, crzid, role, source) VALUES(?,?,?,?,?,?)')
            .run(normKey(name), ico ?? '', normKey(addr ?? ''), ev.crzid, role, 'submitted');
    }
    return true;
}

export function getMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function setMeta(db, key, value) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
}
