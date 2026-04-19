// Extract a layout-aware plain-text view of a PDF using pdfjs-dist.
// Used by both the CLI (Node) and the web UI (browser); the only difference
// between the two callers is how the source bytes are obtained.
//
// We build "lines" by sorting items top-to-bottom (y descending) then
// left-to-right (x ascending), grouping items that share roughly the same
// y coordinate, and joining their strings with single spaces.

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

const Y_TOL = 2;

export async function extractTextFromPdfDoc(pdf: PdfDocHandle): Promise<string> {
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        type Item = { str: string; x: number; y: number };
        const items: Item[] = content.items.map((it) => ({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
        }));
        items.sort((a, b) => b.y - a.y || a.x - b.x);
        const lines: string[] = [];
        let curY: number | null = null;
        let curParts: string[] = [];
        const flush = (): void => {
            if (curParts.length > 0) {
                lines.push(curParts.join(' ').replace(/\s+/g, ' ').trim());
                curParts = [];
            }
        };
        for (const it of items) {
            if (curY === null || Math.abs(it.y - curY) > Y_TOL) {
                flush();
                curY = it.y;
            }
            curParts.push(it.str);
        }
        flush();
        pages.push(lines.join('\n'));
    }
    return pages.join('\n');
}
