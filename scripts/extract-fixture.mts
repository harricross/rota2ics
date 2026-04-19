import { writeFileSync } from 'node:fs';
import { extractPdfText } from '../src/extractPdf.ts';

const src = process.argv[2] ?? 'BMC Feb PA 2026.pdf';
const dst = process.argv[3] ?? 'scripts/fixtures/bmc-feb-pa-2026.txt';
const t = await extractPdfText(src);
writeFileSync(dst, t);
process.stdout.write(`wrote ${t.length} chars to ${dst}\n`);
