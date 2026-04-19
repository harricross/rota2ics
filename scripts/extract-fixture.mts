// Extract text from a real rota PDF. The output is NOT committed; run
// `tsx scripts/anonymize-fixture.mts <out> scripts/fixtures/anon-rota.txt`
// afterwards to refresh the committed anonymised fixture.

import { writeFileSync } from 'node:fs';
import { extractPdfText } from '../src/extractPdf.ts';

const src = process.argv[2] ?? 'BMC Feb PA 2026.pdf';
const dst = process.argv[3] ?? 'scripts/fixtures/_real-rota.txt';
const t = await extractPdfText(src);
writeFileSync(dst, t);
process.stdout.write(`wrote ${t.length} chars to ${dst}\n`);
