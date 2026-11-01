/**
 * Download a contract attachment (the published PDF/text annex under /data/att/).
 * Resolves attachment URLs from the contract detail page, then saves the file.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { contractId, fetchBytes, fetchContract, parseDetail } from './utils.js';
import fs from 'node:fs/promises';

function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'attachment';
}

cli({
    site: 'crz',
    name: 'attachment',
    description: 'Download the attachment (usually the contract PDF) of a CRZ contract',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz attachment 99999901 --out ./contracts',
    args: [
        { name: 'id', positional: true, required: true, type: 'string', help: 'Numeric CRZ contract id' },
        { name: 'index', type: 'int', default: 0, help: 'Attachment number when several are published (0-based)' },
        { name: 'name', type: 'string', help: 'Substring of the attachment title instead of --index' },
        { name: 'out', type: 'string', help: 'Output file path or directory (default: ./<id>-<n>.<ext>)' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 24-hour detail cache' },
    ],
    func: async (args) => {
        const id = contractId(args.id);
        const detail = parseDetail(await fetchContract(id, { fresh: args.fresh === true }));
        const attachments = detail.attachments ?? [];
        if (!attachments.length) {
            throw new EmptyResultError(`Contract ${id} has no downloadable attachment`, 'Some contracts publish the file with a delay; open ' + detail.url);
        }
        let chosen;
        if (args.name) {
            const needle = String(args.name).toLowerCase();
            chosen = attachments.filter((a) => a.name.toLowerCase().includes(needle));
            if (!chosen.length) {
                throw new ArgumentError(`No attachment matching "${args.name}"`, `Available: ${attachments.map((a, i) => `${i}: ${a.name}`).join(' | ')}`);
            }
            chosen = chosen[0];
        } else {
            const index = Number(args.index ?? 0);
            if (!Number.isInteger(index) || index < 0 || index >= attachments.length) {
                throw new ArgumentError(`index ${index} out of range`, `Contract ${id} has ${attachments.length} attachment(s).`);
            }
            chosen = attachments[index];
        }
        const defaultName = `${id}-${sanitize(chosen.name)}.${chosen.ext || 'bin'}`;
        let target = args.out ? String(args.out) : defaultName;
        try {
            if (args.out && (args.out.endsWith('/') || (await fs.stat(args.out)).isDirectory())) {
                target = `${args.out.replace(/\/$/, '')}/${defaultName}`;
            }
        } catch { /* --out points at a new file path */ }
        const bytes = await fetchBytes(chosen.url, { referer: detail.url ?? undefined });
        if (!bytes.length) throw new CommandExecutionError(`Empty download from ${chosen.url}`);
        await fs.writeFile(target, bytes);
        return {
            contractId: Number(id),
            index: attachments.indexOf(chosen),
            name: chosen.name,
            ext: chosen.ext,
            sizeText: chosen.sizeText,
            bytes: bytes.length,
            path: target,
            url: chosen.url,
        };
    },
});
