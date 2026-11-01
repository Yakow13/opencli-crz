#!/usr/bin/env node
/**
 * Isolated-process probes for scenarios that need a FRESH utils.js module
 * (module-level caches) or a sandboxed HOME (cache dir). Running these in
 * test processes would pollute env and confuse coverage attribution.
 * Usage: node test/helpers/isolated-probe.mjs cache|fallback [tmpHome]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2];

function fail(msg) {
    console.error(`PROBE-FAIL: ${msg}`);
    process.exit(1);
}

if (MODE === 'cache') {
    // fetchText lifecycle against a scratch cache dir (spawned with HOME=tmp)
    const utils = await import('../../utils.js');
    let served = 0;
    globalThis.fetch = async () => new Response(`served-${++served}`, { status: 200 });
    const dir = path.join(os.homedir(), '.opencli', 'cache', 'crz');
    const checks = [];
    const eq = (a, b, why) => checks.push([a === b, `${why}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`]);

    eq(await utils.fetchText('https://x.test/a', { ttlMs: 60_000 }), 'served-1', 'first fetch hits network');
    eq(await utils.fetchText('https://x.test/a', { ttlMs: 60_000 }), 'served-1', 'ttl hit serves cache');
    eq(await utils.fetchText('https://x.test/a', { ttlMs: 60_000, fresh: true }), 'served-2', 'fresh bypasses');
    const files = await fs.readdir(dir);
    eq(files.length, 1, 'one cache key per url');
    await fs.utimes(path.join(dir, files[0]), new Date(0), new Date(0));
    eq(await utils.fetchText('https://x.test/a', { ttlMs: 60_000 }), 'served-3', 'expired ttl refetches');
    await fs.writeFile(path.join(dir, files[0]), '}{ not json');
    eq(await utils.fetchText('https://x.test/a', { ttlMs: 60_000 }), 'served-4', 'corrupt cache fail-open');
    const before = served;
    process.env.OPENCLI_CRZ_CACHE = '0';
    await utils.fetchText('https://x.test/b', { ttlMs: 60_000 });
    await utils.fetchText('https://x.test/b', { ttlMs: 60_000 });
    eq(served, before + 2, 'kill-switch never caches');

    const bad = checks.filter(([ok]) => !ok);
    if (bad.length) fail(bad.map(([, m]) => m).join(' | '));
    console.log('PROBE-OK cache');
} else if (MODE === 'fallback') {
    // fresh module: resolveSearchPath must fall back when the form markup is gone
    process.env.OPENCLI_CRZ_CACHE = '0';
    globalThis.fetch = async () => new Response('<html>redesign happened</html>', { status: 200 });
    const utils = await import('../../utils.js');
    const got = await utils.resolveSearchPath();
    if (got !== utils.FALLBACK_SEARCH_PATH) fail(`resolveSearchPath returned ${got}`);
    console.log('PROBE-OK fallback');
} else {
    fail(`unknown probe mode: ${MODE}`);
}
