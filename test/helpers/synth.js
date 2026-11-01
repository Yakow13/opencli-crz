/**
 * Build HTML fragments with the EXACT structure CRZ renders (verified against
 * fixtures). Used when we need controllable data (amounts, dupes, edge dates)
 * instead of a 48 KB recorded page. Fixtures stay the source of truth for
 * reality; builders stay the source of truth for edge combinations.
 */
export function rowsHtml(rows, { nextPage = null } = {}) {
    const tr = rows.map((r) => {
        const number = r.number === undefined || r.number === null ? '' : `<br /><span>${r.number}</span>`;
        const status = r.status ? `<br /><span style="color: #215E00;">${r.status}</span>` : '';
        const href = r.legacy ? `/${r.id}/` : `/zmluva/${r.id}/`; // legacy contracts link under bare path
        return '<tr>'
            + `<td class="cell1"><span class="d-block">${r.pub ?? '1. Január 2025'}</span></td>`
            + `<td class="cell2"><a href="${href}">${r.title ?? 'zmluva'}</a>${number}${status}</td>`
            + `<td class="cell3 text-nowrap text-end">${r.amount ?? '0,00&nbsp;&euro;'}</td>`
            + `<td class="cell4">${r.sup ?? 'Dodávateľ'}</td>`
            + `<td class="cell5">${r.auth ?? 'Objednávateľ'}</td>`
            + '</tr>';
    }).join('');
    const pager = nextPage === null ? ''
        : Array.from({ length: 10 }, (_, k) => nextPage + k) // real bootstrap window: ten numbered links
            .map((idx) => `<li class="page-item"><a class="page-link" href="?page=${idx}" aria-label="Stránka ${idx + 2}">${idx + 1}</a></li>`)
            .join('');
    return `<table class="table"><thead><tr><th>Zverejnené</th></tr></thead><tbody>${tr}</tbody></table>${pager}`;
}

/** Contract detail page skeleton with strong/span label grid + amount block.
 *  amounts: true → BOTH render styles live (span/span agreed + strong/strong total);
 *  'total-only' → only the strong/strong variant (real pages vary; both must parse). */
export function detailHtml({ id = 1, pairs = [], amounts = true, atts = [] } = {}) {
    const grid = pairs.map(([label, value]) =>
        `<li class="py-2"><div class="row gx-3"><strong class="col-sm-3">${label}:</strong><span class="col-sm-9">${value}</span></div></li>`).join('');
    const agreed = '<span class="me-3">Zmluvne dohodnutá čiastka:</span> <span class="text-danger">100,00 €</span>';
    const total = '<strong class="me-3">Celková čiastka:</strong> <strong class="text-danger">200,00 €</strong>';
    const money = amounts === false
        ? `<div class="col-md-3">${total}</div>`
        : `<div class="col-md-9">${agreed}</div><div class="col-md-3">${total}</div>`;
    const attachments = atts.map((a) =>
        `<li><a href="${a.url}">${a.name}</a><br><small>(${a.ext}, ${a.size})</small></li>`).join('');
    return `<html><body><main>
        <h1>Detail ${id}</h1>
        <ul class="list-unstyled">${grid}</ul>
        <div class="card"><h2>Cenové plnenie</h2>${money}</div>
        <ul>${attachments}</ul>
        <a href="/zmluva/${id}/">späť</a>
    </main></body></html>`;
}

export const ATT_PDF_BYTES = Buffer.from('%PDF-1.4\n%fake attachment for tests\n%%EOF\n');
