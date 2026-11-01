/**
 * Fixture access for the offline test tier. Fixtures are synthetic structural fixtures
 * (see build-fixtures.js); tests never hit the network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8'));

export function fixture(name, { raw = false } = {}) {
    const file = path.join(FIXTURES_DIR, name);
    if (!fs.existsSync(file)) {
        throw new Error(`Fixture "${name}" missing — run npm run fixtures`);
    }
    return raw ? fs.readFileSync(file) : fs.readFileSync(file, 'utf8');
}

export function fixtureNames() {
    return Object.keys(manifest).filter((k) => !k.startsWith('_'));
}

export function manifestEntry(name) {
    return manifest[name];
}
