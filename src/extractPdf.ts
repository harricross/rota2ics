// Thin wrapper around pdf-parse so the rest of the code can pretend it has
// a synchronous, plain-text view of the PDF.

import { readFileSync } from 'node:fs';
// pdf-parse is CJS and ships with no proper types for ESM consumption.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - no ESM types
import pdfParse from 'pdf-parse';

export async function extractPdfText(pdfPath: string): Promise<string> {
    const buf = readFileSync(pdfPath);
    const data = await pdfParse(buf);
    return data.text as string;
}
