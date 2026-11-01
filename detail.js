/**
 * Full metadata for one CRZ contract (/zmluva/<id>/).
 * Includes parties, IČOs, dates, amounts and attachment download URLs.
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { contractId, fetchContract, parseDetail } from './utils.js';

cli({
    site: 'crz',
    name: 'detail',
    description: 'Show full details of a CRZ contract by id (from crz search/recent or a /zmluva/<id>/ URL)',
    access: 'read',
    strategy: Strategy.PUBLIC,
    browser: false,
    example: 'opencli crz detail 99999901',
    args: [
        { name: 'id', positional: true, required: true, type: 'string', help: 'Numeric CRZ contract id or /zmluva/<id>/ URL' },
        { name: 'fresh', type: 'boolean', default: false, help: 'Bypass the local 24-hour detail cache' },
    ],
    func: async (args) => {
        const id = contractId(args.id);
        const html = await fetchContract(id, { fresh: args.fresh === true });
        return parseDetail(html);
    },
});
