/**
 * Evidence bundle: one command produces a publishable, verifiable snapshot of
 * a contract — parsed metadata, every attachment, SHA-256 hashes, and a
 * fetch timestamp. CRZ entries can be amended or vanish; this freezes what
 * the register said, at when, under which URL (law 546/2010 public register).
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { contractId, fetchBytes, fetchContract, parseDetail } from './utils.js';

const slugify = (s) => String(s || 'contract')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48).toLowerCase() || 'contract';

const safeName = (i, att) => {
    const ext = String(att.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    return `attachment-${i + 1}-${slugify(att.name)}.${ext}`;
};

cli({
    site: 'crz',
    name: 'evidence',
    description: 'Freeze a contract as an evidence folder: detail.json + attachments + SHA-256 manifest',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz evidence 99999901 --dir cases',
    args: [
        { name: 'id', positional: true, required: true, type: 'string', help: 'Numeric CRZ contract id or /zmluva/<id>/ URL' },
        { name: 'dir', type: 'string', default: 'crz-evidence', help: 'Base directory for the evidence folder' },
        { name: 'no-files', type: 'boolean', default: false, help: 'Skip downloading attachments (metadata only)' },
        { name: 'use-cache', type: 'boolean', default: false, help: 'Allow cached page (default always re-fetches for integrity)' },
    ],
    func: async (args) => {
        const id = contractId(args.id);
        const html = await fetchContract(id, { fresh: args['use-cache'] !== true });
        const detail = parseDetail(html);
        const fetchedAt = new Date().toISOString();
        const folder = path.join(String(args.dir ?? 'crz-evidence'), `${id}-${slugify(detail.title)}`);
        await fs.mkdir(folder, { recursive: true });

        const files = [];
        await fs.writeFile(path.join(folder, 'detail.json'), JSON.stringify(detail, null, 2));
        if (!args['no-files']) {
            const seenUrls = new Set();
            for (let i = 0; i < (detail.attachments ?? []).length; i++) {
                const att = detail.attachments[i];
                if (seenUrls.has(att.url)) continue;
                seenUrls.add(att.url);
                const bytes = await fetchBytes(att.url, { referer: detail.url ?? undefined });
                if (!bytes.length) throw new CommandExecutionError(`Empty download from ${att.url}`);
                const file = path.join(folder, safeName(i, att));
                await fs.writeFile(file, bytes);
                files.push({
                    name: att.name,
                    file: path.basename(file),
                    url: att.url,
                    bytes: bytes.length,
                    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
                });
            }
        }
        const manifest = {
            contractId: Number(id),
            crzUrl: detail.url ?? `https://www.crz.gov.sk/zmluva/${id}/`,
            fetchedAt,
            source: `opencli crz evidence (${process.env.OPENCLI_VERSION ?? 'cli'})`,
            detail: {
                title: detail.title,
                number: detail.number,
                authority: detail.authority,
                supplier: detail.supplier,
                publishedAt: detail.publishedAt,
                totalAmountRaw: detail.totalAmountRaw,
            },
            files,
        };
        await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
        return {
            folder,
            contractId: Number(id),
            attachments: files.length,
            bytes: files.reduce((a, f) => a + f.bytes, 0),
            sha256: Object.fromEntries(files.map((f) => [f.file, f.sha256])),
            manifest: path.join(folder, 'manifest.json'),
        };
    },
});
