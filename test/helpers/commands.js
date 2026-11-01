/**
 * Load an adapter command exactly the way opencli does (ESM import registers
 * it via cli()) and hand back its definition so tests drive def.func(args) —
 * the same call the real CLI makes after arg coercion.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getRegistry } from '@jackwener/opencli/registry';

// Tests must not pollute or read the real page cache.
process.env.OPENCLI_CRZ_CACHE = '0';

// clis/crz — resolved from this file, independent of the caller's cwd.
const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function commandDef(name) {
    await import(path.join(SITE_DIR, `${name}.js`));
    const def = getRegistry().get(`crz/${name}`);
    if (!def) throw new Error(`crz/${name} did not register`);
    return def;
}

export async function allCommandDefs() {
    const names = ['search', 'fulltext', 'recent', 'amendments', 'terminated', 'detail',
        'attachment', 'export', 'feed', 'collect', 'profile', 'evidence'];
    const defs = {};
    for (const n of names) defs[n] = await commandDef(n);
    return defs;
}
