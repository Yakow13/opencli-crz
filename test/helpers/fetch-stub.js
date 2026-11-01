/**
 * globalThis.fetch stub that serves fixtures — production code paths run
 * unchanged, minus the network. Every call is logged so tests can assert on
 * the OUTGOING URLs (the real contract between adapter and site).
 */
import { fixture } from './fixtures.js';

export function installFetch(routes, { defaultStatus = 599 } = {}) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const u = typeof url === 'string' ? url : (url?.url ?? String(url));
        calls.push({ url: u, headers: options.headers ?? {}, method: options.method ?? 'GET' });
        for (const r of routes) {
            const hit = typeof r.match === 'string' ? u === r.match : r.match.test(u);
            if (!hit) continue;
            const body = r.file ? fixture(r.file, { raw: !!r.binary }) : (r.body ?? '');
            return new Response(body, { status: r.status ?? 200 });
        }
        return new Response(`unstubbed: ${u}`, { status: defaultStatus });
    };
    return {
        calls,
        urls: () => calls.map((c) => c.url),
        lastUrl: () => calls.at(-1)?.url ?? '',
        restore: () => { globalThis.fetch = original; },
    };
}

export function paramsOf(url) {
    return Object.fromEntries(new URL(url).searchParams.entries());
}
