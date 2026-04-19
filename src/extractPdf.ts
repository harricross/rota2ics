// Node-side PDF text extraction. Uses the pdfjs-dist legacy build (so it
// runs in plain Node without a browser DOM) and the shared line-builder so
// the resulting text matches what the web UI produces.

import { readFileSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - legacy build ships .mjs without dts in some versions
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextFromPdfDoc, type PdfDocHandle } from './pdfText';

(pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

export async function extractPdfText(pdfPath: string): Promise<string> {
    const buf = readFileSync(pdfPath);
    const pdf = (await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise) as PdfDocHandle;
    return extractTextFromPdfDoc(pdf);
}
