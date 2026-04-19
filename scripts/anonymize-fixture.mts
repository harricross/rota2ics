// Anonymise the extracted-PDF fixture: keep structure (link headers, week
// counts, FD/AO/BM patterns) but scramble all on/off/duration times and BM
// turn-numbers so the file contains no real roster data.
//
// Usage: tsx scripts/anonymize-fixture.mts [in] [out] [seed]
//
// The output is deterministic for a given seed so re-runs don't churn the
// committed fixture.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseRotaText } from '../src/parseRota.ts';

const IN = process.argv[2] ?? 'scripts/fixtures/bmc-feb-pa-2026.txt';
const OUT = process.argv[3] ?? 'scripts/fixtures/anon-rota.txt';
const SEED = Number(process.argv[4] ?? 1);

// --- Tiny seeded PRNG (mulberry32) ------------------------------------------
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = rng(SEED);
const randInt = (min: number, max: number): number =>
    Math.floor(rand() * (max - min + 1)) + min;

const fmt = (h: number, m: number): string =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

// Generate (on, off, duration) such that:
//   - duration is 06:00..09:30 in 15-min steps (matches the <16h test cap)
//   - on is 04:00..22:00 in 15-min steps
//   - off = (on + duration) mod 24
function makeShift(): { on: string; off: string; duration: string } {
    const durMin = randInt(24, 38) * 15; // 360..570 min = 06:00..09:30
    const onMin = randInt(16, 88) * 15; // 04:00..22:00
    const offMin = (onMin + durMin) % (24 * 60);
    return {
        on: fmt(Math.floor(onMin / 60), onMin % 60),
        off: fmt(Math.floor(offMin / 60), offMin % 60),
        duration: fmt(Math.floor(durMin / 60), durMin % 60),
    };
}

const makeBmCode = (): string => `BM ${randInt(100, 9999)}`;

// --- Re-emit one schedule row ------------------------------------------------
//
// Layout per cell:
//   FD                                                   → "FD"
//   working                                              → "<on> <off> <code> <duration>"
// where <code> is "AO" or "BM <digits>".
function emitRow(wk: number, totalHours: string, days: ReturnType<typeof parseRotaText>[number]['weeks'][number]['days']): string {
    const cells = days.map((d) => {
        if (d.code === 'FD') return 'FD';
        const s = makeShift();
        const code = d.code === 'AO' ? 'AO' : makeBmCode();
        return `${s.on} ${s.off} ${code} ${s.duration}`;
    });
    return `${wk} ${totalHours} ${cells.join(' ')}`;
}

// --- Main --------------------------------------------------------------------
const inputText = readFileSync(IN, 'utf8');
const links = parseRotaText(inputText);

const out: string[] = [];
out.push('ANON 01/01/2030');
for (const link of links) {
    out.push(`Link ${link.link} Date: 01/01/2030`);
    out.push('Sunday Monday Tuesday Wednesday Thursday Friday Saturday');
    out.push('Wk Total');
    out.push(
        // Mirrors the column header line in the real PDF text (purely cosmetic;
        // the parser ignores it).
        Array(7).fill('On Off Turn Total').join(' '),
    );
    for (const w of link.weeks) {
        out.push(emitRow(w.wk, w.totalHours, w.days));
    }
    out.push(`Total: ${(link.weeks.length * 37).toFixed(2)} ${(link.weeks.length * 37).toFixed(2)} Avg: 37.00`);
}

const text = out.join('\n') + '\n';
writeFileSync(OUT, text);

// Round-trip check: parser must accept the anonymised output and produce the
// same shape as the input.
const reparsed = parseRotaText(text);
if (reparsed.length !== links.length) {
    process.stderr.write(`link count mismatch: ${reparsed.length} vs ${links.length}\n`);
    process.exit(1);
}
for (let i = 0; i < links.length; i++) {
    const a = links[i];
    const b = reparsed[i];
    if (a.weeks.length !== b.weeks.length) {
        process.stderr.write(`link ${a.link}: week count ${b.weeks.length} != ${a.weeks.length}\n`);
        process.exit(1);
    }
    for (let w = 0; w < a.weeks.length; w++) {
        for (let d = 0; d < 7; d++) {
            const ad = a.weeks[w].days[d];
            const bd = b.weeks[w].days[d];
            if ((ad.code === 'FD') !== (bd.code === 'FD')) {
                process.stderr.write(`link ${a.link} wk ${w + 1} day ${d}: FD mismatch\n`);
                process.exit(1);
            }
            if (ad.code !== 'FD' && bd.code !== 'FD') {
                const aIsAO = ad.code === 'AO';
                const bIsAO = bd.code === 'AO';
                if (aIsAO !== bIsAO) {
                    process.stderr.write(`link ${a.link} wk ${w + 1} day ${d}: AO/BM mismatch\n`);
                    process.exit(1);
                }
            }
        }
    }
}

process.stdout.write(
    `wrote ${text.length} chars to ${OUT} (${links.length} link(s), seed=${SEED})\n`,
);
