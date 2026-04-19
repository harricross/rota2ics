// Comprehensive matrix test: every link × every AO mode × includeRestDays on/off,
// plus a long horizon to exercise wrap-around. Verifies invariants instead of
// snapshotting bytes, so it's resilient to cosmetic changes.

import { existsSync, readFileSync } from 'node:fs';
import { extractPdfText } from '../src/extractPdf';
import { parseRotaText, type Day } from '../src/parseRota';
import { buildEvents, buildIcs, type IcsEvent } from '../src/buildIcs';

const PDF = process.argv[2] ?? 'BMC Feb PA 2026.pdf';
const FIXTURE = 'scripts/fixtures/anon-rota.txt';

interface Failure {
    label: string;
    msg: string;
}

const failures: Failure[] = [];
const fail = (label: string, msg: string): void => {
    failures.push({ label, msg });
    process.stderr.write(`  FAIL  ${label}: ${msg}\n`);
};
const ok = (label: string): void => {
    process.stdout.write(`  ok    ${label}\n`);
};

const countWorkingDays = (days: Day[]): number => days.filter((d) => d.code !== 'FD').length;
const countFD = (days: Day[]): number => days.filter((d) => d.code === 'FD').length;
const countAO = (days: Day[]): number => days.filter((d) => d.code === 'AO').length;
const countBM = (days: Day[]): number => days.filter((d) => d.code !== 'FD' && d.code !== 'AO').length;

// ---------- Parse PDF ----------

let text: string;
let source: string;
if (existsSync(PDF)) {
    text = await extractPdfText(PDF);
    source = PDF;
} else if (existsSync(FIXTURE)) {
    text = readFileSync(FIXTURE, 'utf8');
    source = `${FIXTURE} (fixture; ${PDF} not found)`;
} else {
    process.stderr.write(`Neither ${PDF} nor ${FIXTURE} was found.\n`);
    process.exit(1);
}
const links = parseRotaText(text);
process.stdout.write(`Parsed ${links.length} link(s) from ${source}\n`);
for (const l of links) {
    process.stdout.write(`  Link ${l.link}: ${l.weeks.length} weeks (Date: ${l.date ?? '?'})\n`);
}

// ---------- Robustness: leftmost names column, missing weekly totals ----------
//
// Some PDFs have an extra leftmost column with driver names (and may omit
// the per-week H.MM Total column entirely). Mutate the fixture text and
// assert the parse output matches the unmodified one.
{
    const NAMES = ['Smith', 'Jones-7', 'O Brien', 'McAllister', 'Patel 47', 'BMW Driver', 'AONDO', 'Lee'];
    const variantLines: string[] = [];
    let nameIdx = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        // Detect schedule rows by leading "<wk> <H.MM>" (current real format).
        const m = /^(\d{1,2})\s+(\d{1,2}\.\d{2})\s+(.*)$/.exec(line);
        if (m && parseInt(m[1], 10) >= 1 && parseInt(m[1], 10) <= 99) {
            const name = NAMES[nameIdx++ % NAMES.length];
            // Drop the H.MM total to also exercise the no-total path.
            variantLines.push(`${name} ${m[1]} ${m[3]}`);
        } else if (/^Total:/i.test(line)) {
            // Skip the bottom totals line too.
            continue;
        } else {
            variantLines.push(line);
        }
    }
    const variantText = variantLines.join('\n') + '\n';
    const variantLinks = parseRotaText(variantText);
    const label = 'names-column + no-totals variant';
    if (variantLinks.length !== links.length) {
        fail(label, `link count ${variantLinks.length} != ${links.length}`);
    } else {
        let mismatched = false;
        for (let li = 0; li < links.length; li++) {
            const a = links[li];
            const b = variantLinks[li];
            if (a.link !== b.link || a.weeks.length !== b.weeks.length) {
                fail(label, `link ${a.link} shape mismatch`);
                mismatched = true;
                break;
            }
            for (let wi = 0; wi < a.weeks.length; wi++) {
                if (a.weeks[wi].wk !== b.weeks[wi].wk) {
                    fail(label, `link ${a.link} wk index mismatch at row ${wi}`);
                    mismatched = true;
                    break;
                }
                for (let di = 0; di < 7; di++) {
                    if (JSON.stringify(a.weeks[wi].days[di]) !== JSON.stringify(b.weeks[wi].days[di])) {
                        fail(label, `link ${a.link} wk ${a.weeks[wi].wk} day ${di} differs`);
                        mismatched = true;
                        break;
                    }
                }
                if (mismatched) break;
            }
            if (mismatched) break;
        }
        if (!mismatched) ok(label);
    }
}

// Each row must have exactly 7 days; each working day must have 4 fields populated.
for (const l of links) {
    for (const w of l.weeks) {
        const label = `Link ${l.link} Wk ${w.wk}`;
        if (w.days.length !== 7) {
            fail(label, `expected 7 days, got ${w.days.length}`);
            continue;
        }
        for (let i = 0; i < 7; i++) {
            const d = w.days[i];
            if (d.code === 'FD') continue;
            if (!('on' in d) || !d.on || !d.off || !d.duration || !d.code) {
                fail(label, `day ${i} missing fields: ${JSON.stringify(d)}`);
            }
            if (!/^\d{2}:\d{2}$/.test(d.on) || !/^\d{2}:\d{2}$/.test(d.off) || !/^\d{2}:\d{2}$/.test(d.duration)) {
                fail(label, `day ${i} bad time fmt: ${JSON.stringify(d)}`);
            }
        }
    }
}

// ---------- Per-link expectations ----------
//
// For each link, totalsPerWeek is the sum of working-day events the matrix
// should produce, given the AO mode.

const sundayBase = new Date(2026, 1, 8); // Sunday 8 Feb 2026

const aoModes: Array<'both' | 'allday' | 'timed'> = ['both', 'allday', 'timed'];
const fdToggle = [true, false];

let testNum = 0;

for (const link of links) {
    // Pre-compute aggregate cell counts over ALL weeks of the link.
    const totalDays = link.weeks.reduce((s, w) => s + countWorkingDays(w.days), 0);
    const totalFD = link.weeks.reduce((s, w) => s + countFD(w.days), 0);
    const totalAO = link.weeks.reduce((s, w) => s + countAO(w.days), 0);
    const totalBM = link.weeks.reduce((s, w) => s + countBM(w.days), 0);
    const numWeeks = link.weeks.length;

    if (totalDays + totalFD !== numWeeks * 7) {
        fail(`Link ${link.link}`, `${totalDays} working + ${totalFD} FD != ${numWeeks * 7}`);
    }
    if (totalAO + totalBM !== totalDays) {
        fail(`Link ${link.link}`, `AO+BM (${totalAO}+${totalBM}) != working ${totalDays}`);
    }

    for (const includeRestDays of fdToggle) {
        for (const aoMode of aoModes) {
            // Generate exactly one full cycle so totals match the per-link aggregates.
            for (const startWk of [1, Math.max(1, Math.floor(numWeeks / 2))]) {
                testNum++;
                const label = `Link ${link.link} startWk=${startWk} fd=${includeRestDays} ao=${aoMode}`;
                let events: IcsEvent[];
                try {
                    events = buildEvents({
                        link,
                        startWk,
                        startDate: sundayBase,
                        weeksToGenerate: numWeeks,
                        aoMode,
                        includeRestDays,
                        calendarName: `Test L${link.link}`,
                        summaryPrefix: 'X: ',
                    });
                } catch (e) {
                    fail(label, `buildEvents threw: ${(e as Error).message}`);
                    continue;
                }

                // Expected event counts:
                const expectedFD = includeRestDays ? totalFD : 0;
                const expectedAO =
                    aoMode === 'both' ? totalAO * 2 : totalAO; // either 1 or 2 events per AO cell
                const expectedBM = totalBM;
                const expected = expectedFD + expectedAO + expectedBM;

                if (events.length !== expected) {
                    fail(
                        label,
                        `event count ${events.length} != expected ${expected} ` +
                            `(FD=${expectedFD} AO=${expectedAO} BM=${expectedBM})`,
                    );
                    continue;
                }

                // Categorise.
                let gotFD = 0,
                    gotAOallday = 0,
                    gotAOtimed = 0,
                    gotBM = 0;
                const uids = new Set<string>();
                for (const ev of events) {
                    if (uids.has(ev.uid)) {
                        fail(label, `duplicate UID: ${ev.uid}`);
                    }
                    uids.add(ev.uid);
                    if (!ev.summary.startsWith('X: ')) {
                        fail(label, `summary missing prefix: ${ev.summary}`);
                        break;
                    }
                    const s = ev.summary.slice(3);
                    if (s === 'Rest Day') gotFD++;
                    else if (s === 'AO (As Ordered)') gotAOallday++;
                    else if (s === 'AO (nominal)') gotAOtimed++;
                    else if (/^[A-Z]{2}\s*\d+$/.test(s)) gotBM++;
                    else fail(label, `unexpected summary: ${ev.summary}`);

                    // All-day events have allDay=true and date-aligned bounds.
                    if (ev.allDay) {
                        if (ev.start.getHours() !== 0 || ev.end.getHours() !== 0) {
                            fail(label, `all-day event has H!=0: ${ev.summary}`);
                        }
                        if (ev.end.getTime() - ev.start.getTime() !== 86_400_000) {
                            fail(label, `all-day event not 24h: ${ev.summary}`);
                        }
                    } else {
                        if (ev.end <= ev.start) {
                            fail(label, `timed event end<=start: ${ev.summary}`);
                        }
                        const span = ev.end.getTime() - ev.start.getTime();
                        if (span < 60_000 || span > 16 * 3600_000) {
                            fail(label, `timed event suspicious span ${span}ms: ${ev.summary}`);
                        }
                    }
                }
                if (gotFD !== expectedFD)
                    fail(label, `FD events ${gotFD} != expected ${expectedFD}`);
                if (gotAOallday !== (aoMode === 'timed' ? 0 : totalAO))
                    fail(label, `AO all-day events ${gotAOallday} != expected ${aoMode === 'timed' ? 0 : totalAO}`);
                if (gotAOtimed !== (aoMode === 'allday' ? 0 : totalAO))
                    fail(label, `AO timed events ${gotAOtimed} != expected ${aoMode === 'allday' ? 0 : totalAO}`);
                if (gotBM !== totalBM)
                    fail(label, `BM events ${gotBM} != expected ${totalBM}`);

                // Generate ICS and check basic structure.
                const ics = buildIcs(events, `Test L${link.link}`);
                if (!ics.startsWith('BEGIN:VCALENDAR\r\n')) fail(label, 'ICS missing BEGIN:VCALENDAR');
                if (!ics.endsWith('END:VCALENDAR\r\n')) fail(label, 'ICS missing END:VCALENDAR');
                const vcount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
                if (vcount !== events.length) fail(label, `ICS VEVENT count ${vcount} != ${events.length}`);

                if (failures.length === 0 || failures[failures.length - 1].label !== label) {
                    ok(label);
                }
            }
        }
    }

    // Wrap-around test: generate 3 cycles, expect the same set of events
    // repeated 3× (same UIDs are FORBIDDEN — UIDs include the date so they
    // must all be unique).
    {
        const label = `Link ${link.link} wrap-around (3 cycles)`;
        const events = buildEvents({
            link,
            startWk: 1,
            startDate: sundayBase,
            weeksToGenerate: numWeeks * 3,
            aoMode: 'both',
            includeRestDays: true,
        });
        const expectedPerCycle = totalFD + totalAO * 2 + totalBM;
        if (events.length !== expectedPerCycle * 3) {
            fail(label, `${events.length} events != 3× ${expectedPerCycle}`);
        }
        const uids = new Set(events.map((e) => e.uid));
        if (uids.size !== events.length) {
            fail(label, `duplicate UIDs in wrap-around output (size=${uids.size}, events=${events.length})`);
        }
        if (failures.length === 0 || failures[failures.length - 1].label !== label) {
            ok(label);
        }
    }

    // Midnight-crossing test: every working day whose off<on must produce a
    // timed event with end.day == start.day + 1.
    {
        const label = `Link ${link.link} midnight crossings`;
        const events = buildEvents({
            link,
            startWk: 1,
            startDate: sundayBase,
            weeksToGenerate: numWeeks,
            aoMode: 'timed',
            includeRestDays: false,
        });
        let crossings = 0;
        for (const e of events) {
            if (e.allDay) continue;
            if (e.start.getDate() !== e.end.getDate()) {
                crossings++;
                const expectedEnd = new Date(e.start);
                expectedEnd.setDate(expectedEnd.getDate() + 1);
                if (
                    e.end.getFullYear() !== expectedEnd.getFullYear() ||
                    e.end.getMonth() !== expectedEnd.getMonth() ||
                    e.end.getDate() !== expectedEnd.getDate()
                ) {
                    fail(label, `bad cross-midnight end for ${e.summary}: ${e.start.toISOString()} → ${e.end.toISOString()}`);
                }
            }
        }
        process.stdout.write(`        (${crossings} cross-midnight shifts checked)\n`);
        if (failures.length === 0 || failures[failures.length - 1].label !== label) {
            ok(label);
        }
    }
}

process.stdout.write(`\nRan ${testNum} matrix cases over ${links.length} link(s).\n`);
if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} failure(s).\n`);
    process.exit(1);
} else {
    process.stdout.write(`All checks passed.\n`);
}
