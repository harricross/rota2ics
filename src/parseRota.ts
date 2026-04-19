// Parses the layout-aware text extraction of a UK railway-staff rota PDF
// into structured Link / Week / Day data.
//
// Each schedule row appears on a single line with all 7 day-cells inline:
//
//   1 34.30 07:46 16:22 AO 08:36 07:24 16:09 BM 112 08:45 ...FD FD FD
//
// where each cell is either:
//
//   FD                                — Free Day (rest)
//   <on> <off> <code> <duration>      — working day, code = AO | BM <digits>
//
// Tokens may be glued together (e.g. "08:33FD" or "BM 210207:19"); we use
// regex with constrained lookaheads to disambiguate.

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

// ---------- Tokenisation ----------

type Token =
    | { t: 'time'; v: string }
    | { t: 'fd' }
    | { t: 'ao' }
    | { t: 'turn'; v: string } // working-day code: 2-letter depot prefix + 3–4 digit turn number, e.g. "BM 112", "SA 2119"
    | { t: 'total'; v: string }
    | { t: 'int'; v: number };

// Depot turn code: any 2 uppercase letters followed by a 3- or 4-digit turn
// number. Excludes the special markers AO / FD / RD (those are 2 letters with
// no following digits and are matched separately). The lookahead prevents
// swallowing duration digits that may be glued on (e.g. "BM 210207:19").
//
// XX.YY total comes BEFORE plain integers in the alternation so "34.30" is
// not split into 34 and (later) 30. Times come before plain integers too.
//
// Word boundaries prevent name fragments like "AONDO" or "BMW" from being
// mistaken for cell markers when the rota has a leftmost names column.
const TOK_RE =
    /\b(?!AO|FD|RD)[A-Z]{2}\s*\d{3,4}(?=$|[^0-9]|\d{2}:\d{2})|\bAO\b|\b(?:FD|RD)\b|\d{2}:\d{2}|\d{1,2}\.\d{2}|\d{1,2}/g;

function tokenize(line: string): Token[] {
    const out: Token[] = [];
    for (const m of line.matchAll(TOK_RE)) {
        const s = m[0];
        if (s === 'FD' || s === 'RD') out.push({ t: 'fd' });
        else if (s === 'AO') out.push({ t: 'ao' });
        else if (/^[A-Z]{2}\s*\d{3,4}$/.test(s)) out.push({ t: 'turn', v: s.replace(/\s+/g, ' ') });
        else if (/^\d{2}:\d{2}$/.test(s)) out.push({ t: 'time', v: s });
        else if (/^\d{1,2}\.\d{2}$/.test(s)) out.push({ t: 'total', v: s });
        else out.push({ t: 'int', v: parseInt(s, 10) });
    }
    return out;
}

// ---------- Row parsing ----------

interface ParsedRow {
    wk: number;
    totalHours: string;
    days: Day[];
}

function parseRow(line: string): ParsedRow | null {
    const toks = tokenize(line);
    if (toks.length < 8) return null; // wk + 7 cells (FD-only week is the minimum)

    // The line may be prefixed by a names/payroll column. Try every plausible
    // wk anchor; accept the first start that consumes ALL remaining tokens as
    // exactly 7 valid cells. The per-week H.MM total is optional — some rotas
    // omit that column entirely.
    for (let start = 0; start < toks.length - 7; start++) {
        const wkTok = toks[start];
        if (wkTok.t !== 'int' || wkTok.v < 1 || wkTok.v > 99) continue;

        let i = start + 1;
        let totalHours = '';
        if (toks[i] && toks[i].t === 'total') {
            totalHours = (toks[i] as { t: 'total'; v: string }).v;
            i++;
        }

        const days: Day[] = [];
        let ok = true;
        for (let cell = 0; cell < 7; cell++) {
            const tok = toks[i];
            if (!tok) { ok = false; break; }
            if (tok.t === 'fd') {
                days.push({ code: 'FD' });
                i++;
                continue;
            }
            // Working cell: time, time, (ao | turn), time
            const a = toks[i];
            const b = toks[i + 1];
            const c = toks[i + 2];
            const d = toks[i + 3];
            if (
                !a || !b || !c || !d ||
                a.t !== 'time' || b.t !== 'time' || d.t !== 'time' ||
                (c.t !== 'ao' && c.t !== 'turn')
            ) {
                ok = false;
                break;
            }
            days.push({
                on: a.v,
                off: b.v,
                duration: d.v,
                code: c.t === 'ao' ? 'AO' : c.v,
            });
            i += 4;
        }
        if (!ok) continue;
        if (i !== toks.length) continue; // leftover tokens → wrong start
        return { wk: wkTok.v, totalHours, days };
    }
    return null;
}

// ---------- Header parsing ----------

// "Link 1" / "Link 12" — numeric, optionally with an inline date.
// "LINK A" / "Link B" — single-letter ID; we map A→1, B→2, … so downstream
//   code stays uniform (numeric link IDs).
const RE_LINK_HEADER = /\bLink\s+(\d+|[A-Z])\b\s*(?:Date\s*:\s*(\d{2}\/\d{2}\/\d{4}))?/gi;
const RE_DATE_ONLY = /^Date\s*:\s*(\d{2}\/\d{2}\/\d{4})\s*$/;

const linkIdToNumber = (raw: string): number => {
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return raw.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0) + 1;
};

// ---------- Top-level ----------

export function parseRotaText(text: string): Link[] {
    const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

    // Collect link headers (with optional inline date) and standalone Date: lines.
    const linkHeaders: { link: number; date?: string }[] = [];
    const pendingDates: string[] = [];
    for (const line of lines) {
        const dateOnly = RE_DATE_ONLY.exec(line);
        if (dateOnly) {
            pendingDates.push(dateOnly[1]);
            continue;
        }
        // Pages can have multiple "Link N" tokens on the same line.
        RE_LINK_HEADER.lastIndex = 0;
        let m: RegExpExecArray | null;
        let any = false;
        while ((m = RE_LINK_HEADER.exec(line)) !== null) {
            any = true;
            linkHeaders.push({ link: linkIdToNumber(m[1]), date: m[2] });
        }
        if (any) continue;
    }
    let di = 0;
    for (const h of linkHeaders) {
        if (!h.date && di < pendingDates.length) h.date = pendingDates[di++];
    }
    if (linkHeaders.length === 0) {
        throw new Error('No "Link N" headers found in PDF text.');
    }

    // Parse every schedule row.
    const rows: ParsedRow[] = [];
    for (const line of lines) {
        const r = parseRow(line);
        if (r) rows.push(r);
    }
    if (rows.length === 0) {
        throw new Error('No schedule rows recognised in PDF text.');
    }

    // Group rows into links by Wk-number resets.
    const groupSizes: number[] = [];
    let curStart = 0;
    for (let i = 1; i <= rows.length; i++) {
        const isEnd = i === rows.length || rows[i].wk <= rows[i - 1].wk;
        if (isEnd) {
            groupSizes.push(i - curStart);
            curStart = i;
        }
    }

    if (groupSizes.length !== linkHeaders.length) {
        throw new Error(
            `Found ${linkHeaders.length} link header(s) but ${groupSizes.length} schedule group(s) (sizes: [${groupSizes.join(', ')}]).`,
        );
    }

    const links: Link[] = [];
    let cursor = 0;
    for (let g = 0; g < groupSizes.length; g++) {
        const header = linkHeaders[g];
        const size = groupSizes[g];
        const weeks: Week[] = [];
        for (let r = 0; r < size; r++) {
            const row = rows[cursor + r];
            weeks.push({ wk: row.wk, totalHours: row.totalHours, days: row.days });
        }
        links.push({ link: header.link, date: header.date, weeks });
        cursor += size;
    }
    links.sort((a, b) => a.link - b.link);
    return links;
}
