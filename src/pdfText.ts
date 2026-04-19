// Extract a layout-aware plain-text view of a PDF using pdfjs-dist.
// Used by both the CLI (Node) and the web UI (browser); the only difference
// between the two callers is how the source bytes are obtained.
//
// We build "lines" by sorting items top-to-bottom (y descending) then
// left-to-right (x ascending), grouping items that share roughly the same
// y coordinate, and joining their strings with single spaces.
//
// Wrap-fragment merging
// ---------------------
// Some rotas render wide cells (e.g. a 4-digit turn number like `SA 2119`) by
// wrapping the depot code and the turn-number digits onto separate sub-rows
// *inside* the cell. The data items (times, total, day codes) stay on the
// row's main Y-band, but the depot letters / turn digits land in a Y-band a
// few points above or below. We detect those "fragment" bands and merge them
// back into the nearest data band so the parser sees a single flat row.

export interface PdfTextItem {
    str: string;
    transform: number[];
}

export interface PdfTextContent {
    items: PdfTextItem[];
}

export interface PdfPageHandle {
    getTextContent(): Promise<PdfTextContent>;
}

export interface PdfDocHandle {
    numPages: number;
    getPage(n: number): Promise<PdfPageHandle>;
}

const Y_TOL = 2;       // points: items within this Y diff are on the same band
const Y_MERGE = 12;    // points: max vertical distance to merge a fragment band into a data band
const X_CLUSTER = 8;   // points: items within this X diff are part of the same sub-cell glyph cluster

const HAS_TIME = /\d{2}:\d{2}/;
const FRAGMENT_TOK = /^(?:[A-Z]{2}|\d{3,4})$/;
const ALPHA2 = /^[A-Z]{2}$/;
const DIGITS3OR4 = /^\d{3,4}$/;

interface Item { str: string; x: number; y: number; }

export async function extractTextFromPdfDoc(pdf: PdfDocHandle): Promise<string> {
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const items: Item[] = content.items
            .map((it) => ({
                str: it.str,
                x: it.transform[4],
                y: it.transform[5],
            }))
            .filter((it) => it.str.trim().length > 0);
        items.sort((a, b) => b.y - a.y || a.x - b.x);

        // Group into Y-bands.
        const bands: Item[][] = [];
        {
            let curBand: Item[] = [];
            let curY: number | null = null;
            for (const it of items) {
                if (curY === null || Math.abs(it.y - curY) > Y_TOL) {
                    if (curBand.length) bands.push(curBand);
                    curBand = [];
                    curY = it.y;
                }
                curBand.push(it);
            }
            if (curBand.length) bands.push(curBand);
        }

        // Classify bands.
        type Kind = 'data' | 'fragment' | 'other';
        const isData = (b: Item[]): boolean => b.some((it) => HAS_TIME.test(it.str));
        const isFragment = (b: Item[]): boolean =>
            !isData(b) && b.every((it) => FRAGMENT_TOK.test(it.str.trim()));
        const classified: { items: Item[]; kind: Kind }[] = bands.map((b) => ({
            items: b.slice(),
            kind: isData(b) ? 'data' : isFragment(b) ? 'fragment' : 'other',
        }));

        // Merge each fragment band into the nearest data band by Y proximity.
        for (let fi = 0; fi < classified.length; fi++) {
            if (classified[fi].kind !== 'fragment') continue;
            const fragY = classified[fi].items[0].y;
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let di = 0; di < classified.length; di++) {
                if (classified[di].kind !== 'data') continue;
                const dy = Math.abs(classified[di].items[0].y - fragY);
                if (dy < bestDist && dy <= Y_MERGE) {
                    bestDist = dy;
                    bestIdx = di;
                }
            }
            if (bestIdx >= 0) {
                classified[bestIdx].items.push(...classified[fi].items);
                classified[fi].items = [];
            }
        }

        // Emit each remaining band, x-sorted, with sub-cell glyph clustering
        // so wrapped depot-code/turn-number fragments re-assemble in the
        // correct order.
        const lines: string[] = [];
        for (const band of classified) {
            if (band.items.length === 0) continue;
            band.items.sort((a, b) => a.x - b.x);
            // Cluster items where consecutive x positions differ by <= X_CLUSTER.
            const clusters: Item[][] = [];
            let cur: Item[] = [];
            let lastX = -Infinity;
            for (const it of band.items) {
                if (cur.length > 0 && it.x - lastX <= X_CLUSTER) {
                    cur.push(it);
                } else {
                    if (cur.length) clusters.push(cur);
                    cur = [it];
                }
                lastX = it.x;
            }
            if (cur.length) clusters.push(cur);
            // Within each multi-item cluster, place 2-letter alpha codes
            // before 3–4 digit numbers (other items stay in x order).
            const parts: string[] = [];
            for (const cl of clusters) {
                if (cl.length > 1) {
                    cl.sort((a, b) => {
                        const ra = ALPHA2.test(a.str.trim()) ? 0 : DIGITS3OR4.test(a.str.trim()) ? 1 : 2;
                        const rb = ALPHA2.test(b.str.trim()) ? 0 : DIGITS3OR4.test(b.str.trim()) ? 1 : 2;
                        if (ra !== rb) return ra - rb;
                        return a.x - b.x;
                    });
                }
                parts.push(cl.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
            }
            const line = parts.filter((p) => p.length).join(' ').replace(/\s+/g, ' ').trim();
            if (line.length) lines.push(line);
        }
        pages.push(lines.join('\n'));
    }
    return pages.join('\n');
}
