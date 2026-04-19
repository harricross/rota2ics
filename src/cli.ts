#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
import { extractPdfText } from './extractPdf';
import { parseRotaText, type Link } from './parseRota';
import { buildEvents, buildIcs } from './buildIcs';

interface Args {
    pdf?: string;
    text?: string;          // hidden: read pre-extracted text from a file (handy for testing)
    link?: string;
    row?: string;
    start?: string;
    weeks?: string;
    out?: string;
    name?: string;
    list?: boolean;
    dump?: boolean;         // hidden: print parsed JSON
    noRestDays?: boolean;
    ao?: string;
    prefix?: string;
    help?: boolean;
}

function usage(): never {
    process.stderr.write(
        `rota2ics — convert a UK railway-staff rota PDF into an ICS calendar

Usage:
  rota2ics --pdf <file.pdf> --link <N> [--row <N>] [--start <YYYY-MM-DD>] [options]
  rota2ics --pdf <file.pdf> --list

Required (unless --list / --dump):
  --pdf <file>        Path to the rota PDF
  --link <n>          Which Link (rota) you are on

Options:
  --row  <n>          The Wk row you occupy on the --start date
                      (default: 1)
  --start <date>      Sunday (YYYY-MM-DD) of the first calendar week to output
                      (default: the "Date:" printed at the top of the PDF for
                      the chosen Link)
  --weeks <n>         Number of weeks of events to generate (default 26)
  --out <file>        Output ICS file (default rota.ics)
  --name <text>       Calendar display name (X-WR-CALNAME)
  --no-rest-days      Suppress all-day "Rest Day" events for FD entries
                      (by default FD and AO are both emitted as all-day events)
  --ao <mode>         How to render AO (As Ordered) days:
                        both   = all-day banner + timed event (default)
                        allday = all-day banner only
                        timed  = timed event only
  --prefix <text>     Prefix every event title with <text> (e.g. "Work: ")
  --list              Just list the Links/Wk counts found in the PDF and exit
  --dump              Print the parsed rota as JSON and exit
  --text <file>       Read pre-extracted PDF text from a file instead of --pdf
  --help              Show this message

The script writes "floating" local times (no time-zone), so Google / iOS
calendars will display each shift in the viewer's local time — which is what
you want if you are based in the UK.
`,
    );
    process.exit(1);
}

function parseArgs(argv: string[]): Args {
    const out: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) usage();
        const key = a.slice(2);
        switch (key) {
            case 'list':
            case 'dump':
            case 'help':
            case 'no-rest-days': {
                if (key === 'no-rest-days') out.noRestDays = true;
                else (out as Record<string, boolean>)[key] = true;
                break;
            }
            case 'pdf':
            case 'text':
            case 'link':
            case 'row':
            case 'start':
            case 'weeks':
            case 'out':
            case 'name':
            case 'ao':
            case 'prefix': {
                const v = argv[++i];
                if (v === undefined) usage();
                (out as Record<string, string>)[key] = v;
                break;
            }
            default:
                usage();
        }
    }
    return out;
}

async function loadLinks(args: Args): Promise<Link[]> {
    let text: string;
    if (args.text) {
        text = readFileSync(args.text, 'utf8');
    } else if (args.pdf) {
        text = await extractPdfText(args.pdf);
    } else {
        usage();
    }
    return parseRotaText(text);
}

function parseStartDate(input: string): Date {
    const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`--start must be YYYY-MM-DD, got "${input}"`);
    const d = new Date(
        parseInt(m[1], 10),
        parseInt(m[2], 10) - 1,
        parseInt(m[3], 10),
    );
    if (isNaN(d.getTime())) throw new Error(`Invalid date: "${input}"`);
    return d;
}

function parsePdfDate(input: string): Date {
    // PDF prints dd/mm/yyyy.
    const m = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) throw new Error(`PDF "Date:" not in dd/mm/yyyy form: "${input}"`);
    return new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}

function fmtIso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseAoMode(s: string | undefined): 'both' | 'allday' | 'timed' | undefined {
    if (!s) return undefined;
    if (s === 'both' || s === 'allday' || s === 'timed') return s;
    throw new Error(`--ao must be one of: both, allday, timed (got "${s}")`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) usage();

    const links = await loadLinks(args);

    if (args.list) {
        process.stdout.write(`Found ${links.length} link(s):\n`);
        for (const l of links) {
            process.stdout.write(
                `  Link ${l.link}: ${l.weeks.length} weeks${l.date ? `  (Date: ${l.date})` : ''}\n`,
            );
        }
        return;
    }

    if (args.dump) {
        process.stdout.write(JSON.stringify(links, null, 2) + '\n');
        return;
    }

    if (!args.link) usage();

    const linkNum = parseInt(args.link, 10);
    const link = links.find((l) => l.link === linkNum);
    if (!link) {
        process.stderr.write(
            `Link ${linkNum} not found. Available: ${links.map((l) => l.link).join(', ')}\n`,
        );
        process.exit(2);
    }

    const startWk = args.row ? parseInt(args.row, 10) : 1;

    let startDate: Date;
    let startSource: 'cli' | 'pdf';
    if (args.start) {
        startDate = parseStartDate(args.start);
        startSource = 'cli';
    } else if (link.date) {
        startDate = parsePdfDate(link.date);
        startSource = 'pdf';
        process.stdout.write(
            `Using PDF "Date:" for Link ${link.link} as start: ${args.start ?? link.date} → ${fmtIso(startDate)}\n`,
        );
    } else {
        process.stderr.write(
            `No --start given and Link ${link.link} has no "Date:" in the PDF — please pass --start YYYY-MM-DD.\n`,
        );
        process.exit(2);
    }
    if (startDate.getDay() !== 0) {
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][startDate.getDay()];
        const adjusted = new Date(startDate);
        adjusted.setDate(startDate.getDate() - startDate.getDay());
        const src = startSource === 'pdf' ? `PDF date ${link.date}` : `--start ${args.start}`;
        process.stderr.write(
            `Warning: ${src} is a ${day}, not Sunday. Using previous Sunday: ${fmtIso(adjusted)}.\n`,
        );
        startDate = adjusted;
    }

    const weeks = args.weeks ? parseInt(args.weeks, 10) : 26;

    const events = buildEvents({
        link,
        startWk,
        startDate,
        weeksToGenerate: weeks,
        calendarName: args.name,
        summaryPrefix: args.prefix,
        includeRestDays: !args.noRestDays,
        aoMode: parseAoMode(args.ao),
    });

    const ics = buildIcs(events, args.name ?? `Rota Link ${link.link}`);
    const out = args.out ?? 'rota.ics';
    writeFileSync(out, ics);
    process.stdout.write(
        `Wrote ${events.length} event(s) over ${weeks} week(s) to ${out}\n`,
    );
}

main().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
