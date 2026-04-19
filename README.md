# rota2ics

Convert UK railway-staff rota PDFs (the "Period Allocation" / Link rotas drivers
and guards receive) into an ICS calendar file you can import into Google
Calendar or Apple Calendar (iOS/macOS).

## How a rota PDF is laid out

Each PDF page contains one or more **Links** (rotation cycles). A Link is a
table whose columns are the days of the week (Sun–Sat) and whose rows are
sequentially-numbered **Wk** rows. Each cell is either:

- `FD` — Free Day (rest, no event), or
- A turn / diagram code (`BM 112`, `AO`, `BM 561`, …) plus three times: **On**
  (sign-on), **Off** (sign-off) and **Turn** (paid duration).

You sit on one Wk row for a given calendar week, then advance to the next row
the following week, wrapping back to Wk 1 after the last row. So once you know
your Link, your current Wk row, and the Sunday of the calendar week that row
applies to, the entire future rota is determined.

## Usage

```sh
npm install

# 1. List the Links found in the PDF and how many weeks each one has:
npm start -- --pdf "BMC Feb PA 2026.pdf" --list

# 2. Generate an ICS for someone on Link 1, currently sitting on Wk 1
#    during the calendar week starting Sunday 8 Feb 2026, for 26 weeks:
npm start -- --pdf "BMC Feb PA 2026.pdf" \
    --link 1 --row 1 --start 2026-02-08 \
    --weeks 26 --out my-rota.ics --name "BMC Link 1"
```

Then import `my-rota.ics` into Google Calendar (Settings → Import & export) or
open it on iOS / macOS to add the events to your calendar.

### Options

| Flag | Description |
| --- | --- |
| `--pdf <file>` | Source rota PDF |
| `--link <n>` | Which Link / rota to use |
| `--row <n>` | The Wk row you're on during the `--start` week |
| `--start <YYYY-MM-DD>` | Sunday of the first calendar week to generate |
| `--weeks <n>` | Weeks of events to generate (default 26) |
| `--out <file>` | Output ICS file (default `rota.ics`) |
| `--name <text>` | Calendar display name |
| `--no-rest-days` | Suppress the all-day "Rest Day" events for `FD` cells |
| `--list` | List the Links found in the PDF and exit |
| `--dump` | Print the parsed rota as JSON and exit |

## Notes

- `FD` (Free Day) and `AO` (As Ordered / spare) cells are written as **all-day
  events** — there are no fixed sign-on/off times for them. Booked turns
  (`BM …`) become timed events using their printed sign-on / sign-off.
- Times are written as RFC 5545 "floating" local times (no `TZID`), so each
  shift displays in the viewer's local time zone — appropriate for UK-based
  calendars.
- Shifts that cross midnight (e.g. sign-off `00:18`) automatically roll the end
  date forward by a day.
- Each event has a stable `UID` derived from link / wk / date / code, so
  re-importing a regenerated ICS will update existing events rather than
  duplicating them.

## Project layout

```
src/
  cli.ts          Command-line entry point
  extractPdf.ts   Wraps pdf-parse to get plain text out of the PDF
  parseRota.ts    Parses the text into Link / Week / Day structures
  buildIcs.ts     Builds calendar events and serialises them to ICS
```

## Development

```sh
npm install
npm run build       # type-check + emit dist/
npm start -- --help # run from source via tsx
```
