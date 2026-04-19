// Parses the plain-text extraction of a UK railway-staff rota PDF into
// structured Link / Week / Day data.
//
// `pdf-parse` strips all in-line whitespace, so a typical extracted line looks
// like one of these (notice no spaces between "columns"):
//
//   Link 1Date:05/02/2026
//   134.3007:4616:2208:3607:2416:0908:4507:1415:5008:3608:3617:0908:33
//   FDBM  133BM  133AOBM  132BM  127FD
//   Total:1036.00Avg:37.001036.00
//
// Fortunately every "column" has a distinct token shape:
//
//   Wk number      : 1-2 digits (1..52ish)
//   Total hours    : "XX.YY"
//   Time triple    : "HH:MM HH:MM HH:MM"  (sign-on, sign-off, duration)
//   Day code       : FD | AO | BM<digits>
//
// So we can rebuild the table with regular expressions. We then group rows
// into links by detecting the Wk number resetting to 1.

export interface DayShift {
    /** Sign-on time, e.g. "07:46". */
    on: string;
    /** Sign-off time, e.g. "16:22". May be earlier than `on` if the shift crosses midnight. */
    off: string;
    /** Turn duration as printed, e.g. "08:36" (8h 36m). */
    duration: string;
    /** Turn / diagram code, e.g. "BM 112" or "AO". */
    code: string;
}

export interface RestDay {
    code: 'FD';
}

export type Day = DayShift | RestDay;

export interface Week {
    /** 1-based row number within the link. */
    wk: number;
    /** Total hours as printed (e.g. "34.30" = 34h 30m). */
    totalHours: string;
    /** Exactly 7 entries, indexed Sunday(0) .. Saturday(6). */
    days: Day[];
}

export interface Link {
    /** Link / rota number. */
    link: number;
    /** "Date:" value as printed (dd/mm/yyyy), if present. */
    date?: string;
    weeks: Week[];
}

const RE_TIME = /\d{2}:\d{2}/g;
const RE_CODE = /FD|AO|BM\s*\d+/g;
// A time row, as a single squashed token: <wk><total>.<frac><time><time><time>...
// `\d{1,2}?` is non-greedy so the total is forced to be the trailing "XX.YY".
const RE_TIME_ROW = /^(\d{1,2}?)(\d{2}\.\d{2})((?:\d{2}:\d{2}){3,})$/;
const RE_LINK_HEADER = /^Link\s*(\d+)\s*(?:Date:\s*(\d{2}\/\d{2}\/\d{4}))?\s*$/;
const RE_DATE_ONLY = /^Date:\s*(\d{2}\/\d{2}\/\d{4})\s*$/;

interface TimeRow {
    wk: number;
    totalHours: string;
    triples: { on: string; off: string; duration: string }[];
}

const parseTimeRow = (line: string): TimeRow | null => {
    const squashed = line.replace(/\s+/g, '');
    const m = RE_TIME_ROW.exec(squashed);
    if (!m) return null;
    const wk = parseInt(m[1], 10);
    const totalHours = m[2];
    const times = m[3].match(RE_TIME) ?? [];
    if (times.length === 0 || times.length % 3 !== 0) return null;
    const triples: TimeRow['triples'] = [];
    for (let i = 0; i < times.length; i += 3) {
        triples.push({ on: times[i], off: times[i + 1], duration: times[i + 2] });
    }
    if (triples.length > 7) return null;
    return { wk, totalHours, triples };
};

const parseCodeRow = (line: string): string[] | null => {
    const tokens = line.match(RE_CODE);
    if (!tokens || tokens.length !== 7) return null;
    // Make sure those 7 tokens account for the entire line (no stray digits).
    const stripped = line.replace(RE_CODE, '').replace(/\s+/g, '');
    if (stripped.length > 0) return null;
    return tokens.map((t) => t.replace(/\s+/g, ' '));
};

export function parseRotaText(text: string): Link[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    // 1. Collect Link headers and Date: lines (in document order).
    const linkHeaders: { link: number; date?: string }[] = [];
    const pendingDates: string[] = [];
    for (const line of lines) {
        const lh = RE_LINK_HEADER.exec(line);
        if (lh) {
            linkHeaders.push({ link: parseInt(lh[1], 10), date: lh[2] });
            continue;
        }
        const d = RE_DATE_ONLY.exec(line);
        if (d) pendingDates.push(d[1]);
    }
    // Pages with multiple links list "Link N" lines first, then "Date:" lines.
    let di = 0;
    for (const h of linkHeaders) {
        if (!h.date && di < pendingDates.length) h.date = pendingDates[di++];
    }
    if (linkHeaders.length === 0) {
        throw new Error('No "Link N" headers found in PDF text.');
    }

    // 2. Collect every time row and code row in document order.
    const timeRows: TimeRow[] = [];
    const codeRows: string[][] = [];
    for (const line of lines) {
        const t = parseTimeRow(line);
        if (t) {
            timeRows.push(t);
            continue;
        }
        const c = parseCodeRow(line);
        if (c) codeRows.push(c);
    }

    if (timeRows.length !== codeRows.length) {
        throw new Error(
            `Mismatched table data: ${timeRows.length} time rows vs ${codeRows.length} code rows.`,
        );
    }
    if (timeRows.length === 0) {
        throw new Error('No schedule rows recognised in PDF text.');
    }

    // 3. Sanity-check each row: number of working-day codes == number of time triples.
    for (let i = 0; i < timeRows.length; i++) {
        const working = codeRows[i].filter((c) => c !== 'FD').length;
        if (working !== timeRows[i].triples.length) {
            throw new Error(
                `Row ${i}: ${working} non-FD day codes but ${timeRows[i].triples.length} time triples.\n  codes: ${codeRows[i].join(' ')}\n  times: ${timeRows[i].triples.map((t) => `${t.on}-${t.off}`).join(' ')}`,
            );
        }
    }

    // 4. Detect link boundaries by Wk-number resets (wk drops back to a lower value).
    const groupSizes: number[] = [];
    let curStart = 0;
    for (let i = 1; i <= timeRows.length; i++) {
        const isEnd = i === timeRows.length || timeRows[i].wk <= timeRows[i - 1].wk;
        if (isEnd) {
            groupSizes.push(i - curStart);
            curStart = i;
        }
    }

    if (groupSizes.length !== linkHeaders.length) {
        throw new Error(
            `Found ${linkHeaders.length} link header(s) but detected ${groupSizes.length} schedule group(s) in the table data. Group sizes: [${groupSizes.join(', ')}].`,
        );
    }

    // 5. Build the Link / Week / Day tree.
    const links: Link[] = [];
    let cursor = 0;
    for (let g = 0; g < groupSizes.length; g++) {
        const header = linkHeaders[g];
        const size = groupSizes[g];
        const weeks: Week[] = [];
        for (let r = 0; r < size; r++) {
            const tr = timeRows[cursor + r];
            const codes = codeRows[cursor + r];
            const days: Day[] = [];
            let ti = 0;
            for (const code of codes) {
                if (code === 'FD') {
                    days.push({ code: 'FD' });
                } else {
                    const t = tr.triples[ti++];
                    days.push({ on: t.on, off: t.off, duration: t.duration, code });
                }
            }
            weeks.push({ wk: tr.wk, totalHours: tr.totalHours, days });
        }
        links.push({ link: header.link, date: header.date, weeks });
        cursor += size;
    }

    links.sort((a, b) => a.link - b.link);
    return links;
}
