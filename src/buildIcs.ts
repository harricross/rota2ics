import type { Day, DayShift, Link } from './parseRota.js';

export interface BuildOptions {
    link: Link;
    /** The Wk row number the user is sitting on during the calendar week of `startDate`. */
    startWk: number;
    /** Sunday of the first calendar week to generate (local date). */
    startDate: Date;
    /** Number of calendar weeks of events to generate. */
    weeksToGenerate: number;
    /** Calendar name (X-WR-CALNAME). */
    calendarName?: string;
    /** Optional prefix for each event title, e.g. "Work: ". */
    summaryPrefix?: string;
    /**
     * If false, suppress the all-day "Rest Day" events generated for FD entries.
     * Default: true (FD days produce an all-day event).
     */
    includeRestDays?: boolean;
    /** Description for non-FD shifts, in addition to the code. */
    descriptionTemplate?: (info: {
        link: number;
        wk: number;
        day: DayShift;
        dayIndex: number;
    }) => string;
}

export interface IcsEvent {
    uid: string;
    summary: string;
    description?: string;
    /** Local-time start (floating, no TZ conversion). */
    start: Date;
    /** Local-time end (floating). */
    end: Date;
    /** If true, render as DATE (all-day) rather than DATE-TIME. */
    allDay?: boolean;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number): string => String(n).padStart(2, '0');

const fmtLocalDateTime = (d: Date): string =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

const fmtLocalDate = (d: Date): string =>
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

const fmtUtcStamp = (d: Date): string =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** RFC 5545 line folding: lines must be <= 75 octets. */
const fold = (line: string): string => {
    if (line.length <= 75) return line;
    const out: string[] = [];
    let rest = line;
    out.push(rest.slice(0, 75));
    rest = rest.slice(75);
    while (rest.length > 0) {
        out.push(' ' + rest.slice(0, 74));
        rest = rest.slice(74);
    }
    return out.join('\r\n');
};

const escapeText = (s: string): string =>
    s
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,');

export function buildEvents(opts: BuildOptions): IcsEvent[] {
    const { link, startWk, startDate, weeksToGenerate } = opts;
    const numWeeks = link.weeks.length;
    const byWk = new Map(link.weeks.map((w) => [w.wk, w]));

    if (!byWk.has(startWk)) {
        throw new Error(
            `Link ${link.link} has no Wk ${startWk}. Valid wk numbers: ${link.weeks
                .map((w) => w.wk)
                .join(', ')}`,
        );
    }

    const events: IcsEvent[] = [];

    for (let w = 0; w < weeksToGenerate; w++) {
        const wkNum = ((startWk - 1 + w) % numWeeks) + 1;
        const week = byWk.get(wkNum);
        if (!week) continue;

        const sunday = new Date(startDate);
        sunday.setDate(startDate.getDate() + w * 7);

        for (let d = 0; d < 7; d++) {
            const day: Day = week.days[d];
            const date = new Date(sunday);
            date.setDate(sunday.getDate() + d);
            const nextDay = new Date(date);
            nextDay.setDate(date.getDate() + 1);

            // FD = Free Day: emit an all-day "Rest Day" event (unless suppressed).
            if (day.code === 'FD') {
                if (opts.includeRestDays !== false) {
                    events.push({
                        uid: makeUid(link.link, wkNum, d, date, 'FD'),
                        summary: (opts.summaryPrefix ?? '') + 'Rest Day',
                        description:
                            `Link ${link.link}, Wk ${wkNum}, ${DAY_NAMES[d]}\nFree Day (FD)`,
                        start: date,
                        end: nextDay,
                        allDay: true,
                    });
                }
                continue;
            }

            const ds = day as DayShift;

            // AO = "As Ordered" / spare turn. The PDF shows nominal times but the
            // actual shift is assigned on the day, so render it as an all-day
            // event with the nominal times in the description.
            if (ds.code === 'AO') {
                events.push({
                    uid: makeUid(link.link, wkNum, d, date, 'AO'),
                    summary: (opts.summaryPrefix ?? '') + 'AO (As Ordered)',
                    description:
                        `Link ${link.link}, Wk ${wkNum}, ${DAY_NAMES[d]}\n` +
                        `Nominal sign on: ${ds.on}  Sign off: ${ds.off}  Duration: ${ds.duration}`,
                    start: date,
                    end: nextDay,
                    allDay: true,
                });
                continue;
            }

            const [onH, onM] = ds.on.split(':').map(Number);
            const [offH, offM] = ds.off.split(':').map(Number);
            const start = new Date(date);
            start.setHours(onH, onM, 0, 0);
            const end = new Date(date);
            end.setHours(offH, offM, 0, 0);
            if (end <= start) {
                // Crossed midnight.
                end.setDate(end.getDate() + 1);
            }

            const baseDesc =
                `Link ${link.link}, Wk ${wkNum}, ${DAY_NAMES[d]}\n` +
                `Sign on: ${ds.on}  Sign off: ${ds.off}  Duration: ${ds.duration}`;
            const extra = opts.descriptionTemplate?.({
                link: link.link,
                wk: wkNum,
                day: ds,
                dayIndex: d,
            });

            events.push({
                uid: makeUid(link.link, wkNum, d, date, ds.code),
                summary: (opts.summaryPrefix ?? '') + ds.code,
                description: extra ? `${baseDesc}\n${extra}` : baseDesc,
                start,
                end,
            });
        }
    }

    return events;
}

const makeUid = (
    link: number,
    wk: number,
    dayIdx: number,
    date: Date,
    code: string,
): string =>
    `rota2ics-L${link}-W${wk}-D${dayIdx}-${fmtLocalDate(date)}-${code.replace(/\s+/g, '')}@rota2ics.local`;

export function buildIcs(events: IcsEvent[], calendarName?: string): string {
    const stamp = fmtUtcStamp(new Date());

    const lines: string[] = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//rota2ics//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
    ];
    if (calendarName) {
        lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);
        lines.push(`NAME:${escapeText(calendarName)}`);
    }

    for (const e of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${e.uid}`);
        lines.push(`DTSTAMP:${stamp}`);
        if (e.allDay) {
            lines.push(`DTSTART;VALUE=DATE:${fmtLocalDate(e.start)}`);
            lines.push(`DTEND;VALUE=DATE:${fmtLocalDate(e.end)}`);
            lines.push('TRANSP:TRANSPARENT');
        } else {
            // "Floating" local time (no Z, no TZID): displayed as-is in the
            // viewer's local time zone — which is what UK rail staff want.
            lines.push(`DTSTART:${fmtLocalDateTime(e.start)}`);
            lines.push(`DTEND:${fmtLocalDateTime(e.end)}`);
        }
        lines.push(`SUMMARY:${escapeText(e.summary)}`);
        if (e.description) {
            lines.push(`DESCRIPTION:${escapeText(e.description)}`);
        }
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
}
