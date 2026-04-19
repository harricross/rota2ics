// Browser entry-point for the rota2ics web UI.
// Reuses the same parseRotaText / buildEvents / buildIcs from src/ that the
// CLI uses, plus the shared text-extraction helper, so both paths produce
// identical text and identical parsing.

import * as pdfjs from 'pdfjs-dist';
// Vite-friendly worker import: ?url returns the URL string for the bundled file.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { parseRotaText, type Link } from '../src/parseRota';
import { buildEvents, buildIcs } from '../src/buildIcs';
import { extractTextFromPdfDoc, type PdfDocHandle } from '../src/pdfText';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as T;
};

const pdfInput = $<HTMLInputElement>('#pdf');
const pdfStatus = $<HTMLParagraphElement>('#pdf-status');
const stepLink = $<HTMLElement>('#step-link');
const linkSel = $<HTMLSelectElement>('#link');
const rowSel = $<HTMLSelectElement>('#row');
const startInput = $<HTMLInputElement>('#start');
const weeksInput = $<HTMLInputElement>('#weeks');
const stepOptions = $<HTMLElement>('#step-options');
const nameInput = $<HTMLInputElement>('#name');
const prefixInput = $<HTMLInputElement>('#prefix');
const fdCheck = $<HTMLInputElement>('#opt-fd');
const stepGenerate = $<HTMLElement>('#step-generate');
const generateBtn = $<HTMLButtonElement>('#generate');
const genStatus = $<HTMLParagraphElement>('#gen-status');
const stepPreview = $<HTMLElement>('#step-preview');
const previewBox = $<HTMLDivElement>('#preview');
const previewStatus = $<HTMLParagraphElement>('#preview-status');
const linkStats = $<HTMLParagraphElement>('#link-stats');
const rbFieldset = $<HTMLFieldSetElement>('#rb-fieldset');
const spFieldset = $<HTMLFieldSetElement>('#sp-fieldset');

// ---------- State ----------

let parsedLinks: Link[] = [];
/** True until the user manually edits the start input — lets us auto-fill it. */
let startInputUserEdited = false;

startInput.addEventListener('input', () => {
    startInputUserEdited = true;
});

// ---------- PDF → text ----------

async function extractPdfTextBrowser(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const pdf = (await pdfjs.getDocument({ data: buf }).promise) as unknown as PdfDocHandle;
    return extractTextFromPdfDoc(pdf);
}

// ---------- Wiring ----------

const setStatus = (
    el: HTMLElement,
    msg: string,
    kind: 'info' | 'error' = 'info',
): void => {
    el.textContent = msg;
    el.classList.toggle('error', kind === 'error');
};

const populateLinks = (): void => {
    linkSel.innerHTML = '';
    for (const l of parsedLinks) {
        const o = document.createElement('option');
        o.value = String(l.link);
        o.textContent = `Link ${l.link} (${l.weeks.length} weeks${l.date ? `, ${l.date}` : ''})`;
        linkSel.appendChild(o);
    }
    populateRows();
};

const populateRows = (): void => {
    const link = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    rowSel.innerHTML = '';
    if (!link) return;
    for (const w of link.weeks) {
        const o = document.createElement('option');
        o.value = String(w.wk);
        o.textContent = `Wk ${w.wk}`;
        rowSel.appendChild(o);
    }
};

const pdfDateToIso = (s: string | undefined): string | null => {
    if (!s) return null;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
};
void pdfDateToIso; // currently unused; kept for potential future "use PDF date" toggle

const applyLinkDefaults = (): void => {
    const link = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    if (!link) return;
    if (!startInputUserEdited && !startInput.value) {
        startInput.value = defaultStartSunday();
    }
    if (!rowSel.value && rowSel.options.length > 0) rowSel.value = '1';
    renderLinkStats(link);
};

/** Parse a printed total like "34.30" or "34:30" (= 34h 30m) into total minutes. */
const parseHoursDotMinutes = (s: string): number | null => {
    const m = s.match(/^(\d{1,2})[.:](\d{2})$/);
    if (!m) return null;
    const mins = parseInt(m[2], 10);
    if (mins >= 60) return null;
    return parseInt(m[1], 10) * 60 + mins;
};

const fmtHM = (totalMinutes: number): string => {
    const h = Math.floor(totalMinutes / 60);
    const m = Math.round(totalMinutes - h * 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
};

const renderLinkStats = (link: Link): void => {
    const numWeeks = link.weeks.length;
    const startWk = parseInt(rowSel.value, 10) || 1;
    const horizon = Math.max(
        1,
        Math.min(260, parseInt(weeksInput.value, 10) || 26),
    );

    // Walk the cycle starting at startWk for `horizon` weeks.
    let total = 0;
    let counted = 0;
    for (let w = 0; w < horizon; w++) {
        const wk = ((startWk - 1 + w) % numWeeks) + 1;
        const week = link.weeks.find((x) => x.wk === wk);
        if (!week) continue;
        const mins = parseHoursDotMinutes(week.totalHours);
        if (mins !== null) {
            total += mins;
            counted++;
        }
    }
    if (counted === 0) {
        linkStats.textContent = '';
        return;
    }
    const avg = total / counted;
    linkStats.innerHTML =
        `Link <strong>${link.link}</strong> — ` +
        `${counted} week${counted === 1 ? '' : 's'} from Wk <strong>${startWk}</strong>, ` +
        `total <strong>${fmtHM(total)}</strong>, ` +
        `average <strong>${fmtHM(avg)}</strong>/week`;
};

const refreshStats = (): void => {
    const link = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    if (link) renderLinkStats(link);
};

const defaultStartSunday = (): string => {
    const today = new Date();
    const d = new Date(today);
    // Upcoming Sunday: today if today is already Sunday, else next Sunday.
    const dow = today.getDay();
    const offset = dow === 0 ? 0 : 7 - dow;
    d.setDate(today.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

pdfInput.addEventListener('change', async () => {
    const file = pdfInput.files?.[0];
    if (!file) return;
    setStatus(pdfStatus, `Reading ${file.name}…`);
    stepLink.hidden = true;
    stepOptions.hidden = true;
    stepGenerate.hidden = true;
    stepPreview.hidden = true;

    try {
        const text = await extractPdfTextBrowser(file);
        parsedLinks = parseRotaText(text);
        setStatus(
            pdfStatus,
            `Parsed ${parsedLinks.length} link(s): ${parsedLinks
                .map((l) => `Link ${l.link} (${l.weeks.length}w)`)
                .join(', ')}`,
        );
        populateLinks();
        applyLinkDefaults();
        rbFieldset.hidden = !anyLinkHasRB(parsedLinks);
        spFieldset.hidden = !anyLinkHasSP(parsedLinks);
        if (!nameInput.value && parsedLinks[0]) {
            nameInput.value = `Rota Link ${parsedLinks[0].link}`;
        }
        stepLink.hidden = false;
        stepOptions.hidden = false;
        stepGenerate.hidden = false;
        updatePreview();
    } catch (err) {
        setStatus(
            pdfStatus,
            `Could not parse PDF: ${err instanceof Error ? err.message : String(err)}`,
            'error',
        );
    }
});

linkSel.addEventListener('change', () => {
    populateRows();
    applyLinkDefaults();
    const l = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    if (l && (!nameInput.value || /^Rota Link \d+$/.test(nameInput.value))) {
        nameInput.value = `Rota Link ${l.link}`;
    }
    updatePreview();
});

rowSel.addEventListener('change', () => {
    refreshStats();
    updatePreview();
});
weeksInput.addEventListener('input', () => {
    refreshStats();
    updatePreview();
});
startInput.addEventListener('change', () => updatePreview());
nameInput.addEventListener('input', () => updatePreview());
prefixInput.addEventListener('input', () => updatePreview());
fdCheck.addEventListener('change', () => updatePreview());
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="ao"], input[name="rb"], input[name="sp"]')) {
    r.addEventListener('change', () => updatePreview());
}

const getAoMode = (): 'both' | 'allday' | 'timed' => {
    const checked = document.querySelector<HTMLInputElement>(
        'input[name="ao"]:checked',
    );
    return (checked?.value as 'both' | 'allday' | 'timed') ?? 'both';
};

const getRbMode = (): 'both' | 'allday' | 'timed' => {
    const checked = document.querySelector<HTMLInputElement>(
        'input[name="rb"]:checked',
    );
    return (checked?.value as 'both' | 'allday' | 'timed') ?? 'both';
};

const anyLinkHasRB = (links: Link[]): boolean =>
    links.some((l) => l.weeks.some((w) => w.days.some((d) => d.code === 'RB')));

const getSpMode = (): 'both' | 'allday' | 'timed' => {
    const checked = document.querySelector<HTMLInputElement>(
        'input[name="sp"]:checked',
    );
    return (checked?.value as 'both' | 'allday' | 'timed') ?? 'both';
};

const anyLinkHasSP = (links: Link[]): boolean =>
    links.some((l) => l.weeks.some((w) => w.days.some((d) => d.code === 'SP')));

const parseStartDate = (s: string): Date => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
};

const slugify = (s: string): string =>
    s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'rota';

interface ComputedEvents {
    events: ReturnType<typeof buildEvents>;
    weeks: number;
    link: Link;
    note?: string;
}

/**
 * Compute events from the current form state. Returns null and writes a
 * status message if inputs are incomplete or invalid. Used by both the
 * always-on preview and the Generate-and-download flow.
 */
const computeEvents = (statusEl: HTMLElement): ComputedEvents | null => {
    const link = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    if (!link) {
        setStatus(statusEl, 'No Link selected.', 'error');
        return null;
    }
    const startWk = parseInt(rowSel.value, 10);
    if (!startWk) {
        setStatus(statusEl, 'No Wk row selected.', 'error');
        return null;
    }
    if (!startInput.value) {
        setStatus(statusEl, 'Please pick a start Sunday.', 'error');
        return null;
    }
    let start = parseStartDate(startInput.value);
    let note: string | undefined;
    if (start.getDay() !== 0) {
        const adjusted = new Date(start);
        adjusted.setDate(start.getDate() - start.getDay());
        note = `Note: ${startInput.value} isn't a Sunday — using previous Sunday ${adjusted.toISOString().slice(0, 10)}.`;
        start = adjusted;
    }
    const weeks = Math.max(1, Math.min(260, parseInt(weeksInput.value, 10) || 26));

    try {
        const events = buildEvents({
            link,
            startWk,
            startDate: start,
            weeksToGenerate: weeks,
            calendarName: nameInput.value || undefined,
            summaryPrefix: prefixInput.value || undefined,
            includeRestDays: fdCheck.checked,
            aoMode: getAoMode(),
            rbMode: getRbMode(),
            spMode: getSpMode(),
        });
        return { events, weeks, link, note };
    } catch (err) {
        setStatus(
            statusEl,
            `Error: ${err instanceof Error ? err.message : String(err)}`,
            'error',
        );
        return null;
    }
};

const fmtDateTime = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});
const fmtDate = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
});

const renderPreview = (events: ReturnType<typeof buildEvents>): void => {
    stepPreview.hidden = false;
    previewBox.innerHTML = '';
    for (const e of events.slice(0, 12)) {
        const div = document.createElement('div');
        div.className = 'evt';
        const when = e.allDay
            ? `${fmtDate.format(e.start)} (all day)`
            : `${fmtDateTime.format(e.start)} → ${fmtDateTime.format(e.end)}`;
        div.innerHTML = `<strong>${escapeHtml(e.summary)}</strong><br><span class="date">${escapeHtml(when)}</span>`;
        previewBox.appendChild(div);
    }
    if (events.length > 12) {
        const more = document.createElement('div');
        more.className = 'evt';
        more.textContent = `… and ${events.length - 12} more.`;
        previewBox.appendChild(more);
    }
};

/** Recompute and re-render the preview. Safe to call any time inputs change. */
const updatePreview = (): void => {
    if (parsedLinks.length === 0) return;
    // Clear any previous error from a failed Generate so the live preview
    // doesn't display stale messages while the user fiddles with controls.
    if (genStatus.classList.contains('error')) setStatus(genStatus, '');
    const computed = computeEvents(previewStatus);
    if (!computed) {
        // computeEvents wrote an error to previewStatus; hide the events list
        previewBox.innerHTML = '';
        return;
    }
    setStatus(
        previewStatus,
        computed.note
            ? `${computed.note} Showing ${computed.events.length} event(s) over ${computed.weeks} week(s).`
            : `Showing ${computed.events.length} event(s) over ${computed.weeks} week(s).`,
    );
    renderPreview(computed.events);
};

const buildAndDownload = (): void => {
    setStatus(genStatus, '');
    const computed = computeEvents(genStatus);
    if (!computed) return;
    const { events, weeks, link, note } = computed;

    const ics = buildIcs(events, nameInput.value || `Rota Link ${link.link}`);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(nameInput.value || `rota-link-${link.link}`)}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    setStatus(
        genStatus,
        (note ? `${note} ` : '') +
            `Downloaded ${events.length} event(s) over ${weeks} week(s).`,
    );

    // Keep the preview in sync with what was just downloaded.
    renderPreview(events);
};

const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) =>
        c === '&'
            ? '&amp;'
            : c === '<'
              ? '&lt;'
              : c === '>'
                ? '&gt;'
                : c === '"'
                  ? '&quot;'
                  : '&#39;',
    );

generateBtn.addEventListener('click', buildAndDownload);
