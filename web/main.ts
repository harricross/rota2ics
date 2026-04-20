// Browser entry-point for the rota2ics web UI.
// Reuses the same parseRotaText / buildEvents / buildIcs from src/ that the
// CLI uses, plus the shared text-extraction helper, so both paths produce
// identical text and identical parsing.

import * as pdfjs from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { parseRotaText, type Link } from '../src/parseRota';
import { buildEvents, buildIcs } from '../src/buildIcs';
import { extractTextFromPdfDoc, type PdfDocHandle } from '../src/pdfText';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

const $ = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`Missing element: ${sel}`);
    return el as T;
};

const pdfInput = $<HTMLInputElement>('#pdf');
const pdfFilename = $<HTMLParagraphElement>('#pdf-filename');
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
const fdFieldset = $<HTMLFieldSetElement>('#fd-fieldset');
const aoFieldset = $<HTMLFieldSetElement>('#ao-fieldset');
const spFieldset = $<HTMLFieldSetElement>('#sp-fieldset');
const rbFieldset = $<HTMLFieldSetElement>('#rb-fieldset');
const iosNote = $<HTMLParagraphElement>('#ios-note');
const iosDismiss = $<HTMLButtonElement>('#ios-note-dismiss');
const resetAll = $<HTMLButtonElement>('#reset-all');
const actionBar = $<HTMLDivElement>('#action-bar');
const actionBarSummary = $<HTMLDivElement>('#action-bar-summary');
const actionBarDownload = $<HTMLButtonElement>('#action-bar-download');

let parsedLinks: Link[] = [];
let startInputUserEdited = false;

startInput.addEventListener('input', () => {
    startInputUserEdited = true;
});

// ---------- Persistence ----------

const STORAGE_KEY = 'rota2ics:settings:v1';
const IOS_DISMISS_KEY = 'rota2ics:ios-note-dismissed';

interface PersistedSettings {
    name?: string;
    prefix?: string;
    weeks?: number;
    includeFd?: boolean;
    ao?: 'both' | 'allday' | 'timed';
    sp?: 'both' | 'allday' | 'timed';
    rb?: 'both' | 'allday' | 'timed';
}

const savePrefs = (): void => {
    try {
        const data: PersistedSettings = {
            name: nameInput.value || undefined,
            prefix: prefixInput.value || undefined,
            weeks: parseInt(weeksInput.value, 10) || 26,
            includeFd: fdCheck.checked,
            ao: getRadioMode('ao'),
            sp: getRadioMode('sp'),
            rb: getRadioMode('rb'),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
        /* ignore */
    }
};

const loadPrefs = (): void => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw) as PersistedSettings;
        if (data.name) nameInput.value = data.name;
        if (data.prefix) prefixInput.value = data.prefix;
        if (typeof data.weeks === 'number') weeksInput.value = String(data.weeks);
        if (typeof data.includeFd === 'boolean') fdCheck.checked = data.includeFd;
        for (const name of ['ao', 'sp', 'rb'] as const) {
            const v = data[name];
            if (!v) continue;
            const r = document.querySelector<HTMLInputElement>(
                `input[name="${name}"][value="${v}"]`,
            );
            if (r) r.checked = true;
        }
        updateChipsFromInput();
    } catch {
        /* ignore */
    }
};

// ---------- iOS UA banner ----------

const isIOS = (): boolean =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

if (isIOS() && !localStorage.getItem(IOS_DISMISS_KEY)) {
    iosNote.hidden = false;
}

iosDismiss.addEventListener('click', () => {
    iosNote.hidden = true;
    try {
        localStorage.setItem(IOS_DISMISS_KEY, '1');
    } catch {
        /* ignore */
    }
});

// ---------- PDF → text ----------

async function extractPdfTextBrowser(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const pdf = (await pdfjs.getDocument({ data: buf }).promise) as unknown as PdfDocHandle;
    return extractTextFromPdfDoc(pdf);
}

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
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm}-${dd}`;
};

const applyLinkDefaults = (): void => {
    const link = parsedLinks.find((l) => l.link === parseInt(linkSel.value, 10));
    if (!link) return;
    if (!startInputUserEdited) {
        const iso = pdfDateToIso(link.date) ?? defaultStartSunday();
        startInput.value = iso;
    }
    if (!rowSel.value && rowSel.options.length > 0) rowSel.value = '1';
    renderLinkStats(link);
};

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
    const dow = today.getDay();
    const offset = dow === 0 ? 0 : 7 - dow;
    d.setDate(today.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- Per-code detection (FD/RD, AO, SP, RB) ----------

type Mode = 'both' | 'allday' | 'timed';

const hasCode = (links: Link[], codes: readonly string[]): boolean => {
    for (const l of links) {
        for (const w of l.weeks) {
            for (const d of w.days) {
                if (codes.includes(d.code)) return true;
            }
        }
    }
    return false;
};

const getRadioMode = (name: 'ao' | 'sp' | 'rb'): Mode => {
    const checked = document.querySelector<HTMLInputElement>(
        `input[name="${name}"]:checked`,
    );
    return (checked?.value as Mode) ?? 'both';
};

// ---------- Weeks chips ----------

const chips = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.chip[data-weeks]'),
);

const updateChipsFromInput = (): void => {
    const v = parseInt(weeksInput.value, 10);
    for (const c of chips) {
        c.classList.toggle('active', parseInt(c.dataset.weeks ?? '', 10) === v);
    }
};

for (const c of chips) {
    c.addEventListener('click', () => {
        weeksInput.value = c.dataset.weeks ?? '';
        updateChipsFromInput();
        refreshStats();
        updatePreview();
        savePrefs();
    });
}

// ---------- PDF picker ----------

pdfInput.addEventListener('change', async () => {
    const file = pdfInput.files?.[0];
    if (!file) return;
    pdfFilename.hidden = false;
    pdfFilename.textContent = file.name;
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

        fdFieldset.hidden = !hasCode(parsedLinks, ['FD']);
        aoFieldset.hidden = !hasCode(parsedLinks, ['AO']);
        spFieldset.hidden = !hasCode(parsedLinks, ['SP']);
        rbFieldset.hidden = !hasCode(parsedLinks, ['RB']);

        if (!nameInput.value && parsedLinks[0]) {
            nameInput.value = `Rota Link ${parsedLinks[0].link}`;
        }
        stepLink.hidden = false;
        stepOptions.hidden = false;
        stepGenerate.hidden = false;
        actionBar.hidden = false;
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
    updateChipsFromInput();
    refreshStats();
    updatePreview();
    savePrefs();
});
startInput.addEventListener('change', () => updatePreview());
nameInput.addEventListener('input', () => {
    updatePreview();
    savePrefs();
});
prefixInput.addEventListener('input', () => {
    updatePreview();
    savePrefs();
});
fdCheck.addEventListener('change', () => {
    updatePreview();
    savePrefs();
});
for (const r of document.querySelectorAll<HTMLInputElement>(
    'input[name="ao"], input[name="sp"], input[name="rb"]',
)) {
    r.addEventListener('change', () => {
        updatePreview();
        savePrefs();
    });
}

// ---------- Reset ----------

resetAll.addEventListener('click', () => {
    if (!confirm('Clear the chosen PDF and start over? Saved settings stay.')) return;
    parsedLinks = [];
    pdfInput.value = '';
    pdfFilename.hidden = true;
    pdfFilename.textContent = '';
    setStatus(pdfStatus, '');
    stepLink.hidden = true;
    stepOptions.hidden = true;
    stepGenerate.hidden = true;
    stepPreview.hidden = true;
    actionBar.hidden = true;
    fdFieldset.hidden = true;
    aoFieldset.hidden = true;
    spFieldset.hidden = true;
    rbFieldset.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- Build / Preview ----------

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
            aoMode: getRadioMode('ao'),
            spMode: getRadioMode('sp'),
            rbMode: getRadioMode('rb'),
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

const updateActionBarSummary = (computed: ComputedEvents | null): void => {
    if (!computed) {
        actionBarSummary.textContent = 'Fill in the options above';
        return;
    }
    actionBarSummary.textContent =
        `Link ${computed.link.link} · Wk ${parseInt(rowSel.value, 10)} · ${computed.weeks} weeks · ${computed.events.length} events`;
};

const updatePreview = (): void => {
    if (parsedLinks.length === 0) return;
    if (genStatus.classList.contains('error')) setStatus(genStatus, '');
    const computed = computeEvents(previewStatus);
    updateActionBarSummary(computed);
    if (!computed) {
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
actionBarDownload.addEventListener('click', buildAndDownload);

loadPrefs();
updateChipsFromInput();
