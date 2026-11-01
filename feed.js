/**
 * Newest contracts via the official CRZ RSS feed (/data/static/rss.xml).
 * Unlike the HTML list this gives precise publication timestamps.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { BASE, decodeEntities, fetchText, parseAmount, TTL_FEED } from './utils.js';

cli({
    site: 'crz',
    name: 'feed',
    description: 'Latest CRZ contract publications from the RSS feed, with timestamps',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz feed --limit 15',
    args: [
        { name: 'limit', type: 'int', default: 20, help: 'Number of items (max 100)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 60-second feed cache' },
    ],
    columns: ['publishedAt', 'title', 'amount', 'authority', 'supplier', 'id'],
    func: async (args) => {
        const xml = await fetchText(`${BASE}/data/static/rss.xml`, { referer: `${BASE}/`, fresh: args.fresh === true, ttlMs: TTL_FEED });
        const items = [];
        for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
            const block = m[1];
            const field = (name) => {
                const f = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
                return f ? decodeEntities(f[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
            };
            const title = field('title');
            const link = field('link');
            const description = field('description');
            const pubDate = field('pubDate');
            const amountMatch = title.match(/\(Cena:\s*([^)]+)\)/);
            const sliceAfter = (label, until) => {
                const from = description.indexOf(label);
                if (from < 0) return '';
                const to = until ? description.indexOf(until, from + label.length) : -1;
                const raw = to > from ? description.slice(from + label.length, to) : description.slice(from + label.length);
                return raw.replace(/,\s*$/, '').trim();
            };
            const authority = sliceAfter('Objednávateľ:', 'Dodávateľ:');
            const supplier = sliceAfter('Dodávateľ:', 'Objednávateľ:');
            const amount = parseAmount(amountMatch ? amountMatch[1] : '');
            const idMatch = link.match(/\/zmluva\/(\d+)/) ?? link.match(/[?&]ID=(\d+)/);
            items.push({
                id: idMatch ? Number(idMatch[1]) : null,
                title: title.replace(/\s*\(Cena:[^)]*\)\s*$/, '').trim(),
                amount: amount.value,
                amountRaw: amountMatch ? amount.raw : null,
                authority,
                supplier,
                publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
                url: idMatch ? `${BASE}/zmluva/${idMatch[1]}/` : link,
            });
        }
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), 100));
        return items.slice(0, limit);
    },
});
