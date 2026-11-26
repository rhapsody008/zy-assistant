// The CLI: read the board, apply the rules, print what they say; read the Mac's
// calendar, print what it holds; report what happened since the previous workday.
// It changes nothing, so it needs no store, no Slack and no scheduler.
//
// Every dependency is injected (the board, the calendar export, the clock, the sink,
// the env, the network), so the whole command runs in a test without a network, a
// real clock, a Calendar or a token. The entry point at the bottom of the file is
// the only part that touches process.

import { parseArgs } from "node:util";
import { brief, type Brief } from "./brief.ts";
import { appFromEnv, exportCalendar, MAC_DEPS, renderCalendar } from "./calendar-export.ts";
import type { CalendarSnapshot } from "./calendar.ts";
import { loadEnv, type Env } from "./env.ts";
import { errMessage } from "./errors.ts";
import { createBoardClient, type BoardSource, type FetchLike } from "./github.ts";
import { renderBrief, renderText, type Links } from "./render.ts";
import { localNow, TZ } from "./time.ts";
import { CALENDAR_DAYS_BACK, renderYesterday, yesterday, type CalendarSource } from "./yesterday.ts";

export interface CliDeps {
  board: BoardSource;
  now: () => Date;
  out: (s: string) => void;
  env: Env;
}

/** What `zya calendar` needs: the export, the sink and the zone it renders in. No token, no board. */
export interface CalendarCliDeps {
  calendar: CalendarSource;
  out: (s: string) => void;
  tz: string;
}

/**
 * What `zya yesterday` needs: the board read, the calendar export, the clock and
 * the sink, and the network the notes and comment reads go through.
 */
export interface YesterdayCliDeps {
  board: BoardSource;
  calendar: CalendarSource;
  now: () => Date;
  out: (s: string) => void;
  env: Env;
  fetchFn?: FetchLike;
}

type Format = "md" | "json";

/** What a flag may say. Anything else is a usage error, never a silent default. */
const FORMATS: readonly Format[] = ["md", "json"];
const LINKS: readonly Links[] = ["md", "plain", "slack"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The window a `zya calendar` run may ask for: whole days, and a fortnight back. */
const DAYS_MAX = 14;
const FROM_MIN = -CALENDAR_DAYS_BACK;

const USAGE = `zya: a read-only view of ZY's board

  zya brief [--date YYYY-MM-DD] [--format md|json] [--links md|plain|slack]
  zya calendar [--days N] [--from N] [--format md|json]
  zya yesterday [--date YYYY-MM-DD] [--format md|json]

  brief     the morning briefing of a day (default: today), as text or as JSON
  links     how a row's link and emphasis are written: markdown (default), plain
            text for a terminal, or the Slack markup the briefing is built in
  calendar  the Mac's calendar, read through Calendar.app: N days (1..${DAYS_MAX},
            default 3) from today, or from N days before today (--from ${FROM_MIN}..0,
            default 0), as markdown (default) or as JSON
  yesterday the board updates, their comments, the notes-repo commits and the
            meetings since the previous workday (a Monday covers the weekend),
            as markdown (default) or as JSON
`;

/** The three commands, each already checked: what a run is given, never a flag to re-read. */
type Command =
  | { cmd: "brief"; date: string | null; format: Format; links: Links } // date null: today
  | { cmd: "calendar"; from: number; days: number; format: Format }
  | { cmd: "yesterday"; date: string | null; format: Format }; // date null: today

/** One of the named values, or null: a typo is a usage error, not a default. */
function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T | null {
  if (value === undefined) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/** A whole number of days in [min, max], or the fallback when the flag is unset; null for anything else. */
function dayCount(value: string | undefined, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  // The shape first: Number() reads " 3", "3.0" and "1e3" as numbers, and none of
  // them is the count of days someone typed.
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * A day, and only a day: the shape alone accepts 2026-02-30, which time.ts would
 * read as 2 March, and 2026-13-45, which it cannot read at all. A date that does
 * not come back as itself is not the date the caller asked for.
 */
function isDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * `--from -1` is how a person writes a window that starts yesterday, and node's
 * parser reads a value starting with a dash only after `=`: the pair is joined
 * before it is parsed, so the flag people type works and `--from=-1` works too.
 */
function glueFrom(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    if (argv[i] === "--from" && next !== undefined) {
      out.push(`--from=${next}`);
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

/**
 * `zya brief`'s or `zya calendar`'s arguments, or null when the command line is
 * neither. A flag the command does not have is a usage error rather than one
 * quietly ignored: `zya calendar --date …` was written by someone who meant
 * something else.
 */
function parseCommand(argv: string[]): Command | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: glueFrom(argv),
      allowPositionals: true,
      options: {
        date: { type: "string" },
        format: { type: "string" },
        links: { type: "string" },
        days: { type: "string" },
        from: { type: "string" },
      },
    });
  } catch {
    return null; // an unknown flag, or one with no value
  }
  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0) return null;
  const { date, format, links, days, from } = parsed.values;
  const namedFormat = oneOf(FORMATS, format, "md");
  if (namedFormat === null) return null;

  if (command === "brief") {
    if (days !== undefined || from !== undefined) return null;
    if (date !== undefined && !isDate(date)) return null;
    const namedLinks = oneOf(LINKS, links, "md");
    if (namedLinks === null) return null;
    return { cmd: "brief", date: date ?? null, format: namedFormat, links: namedLinks };
  }

  if (command === "calendar") {
    if (date !== undefined || links !== undefined) return null;
    const namedDays = dayCount(days, 1, DAYS_MAX, 3);
    const namedFrom = dayCount(from, FROM_MIN, 0, 0);
    if (namedDays === null || namedFrom === null) return null;
    return { cmd: "calendar", from: namedFrom, days: namedDays, format: namedFormat };
  }

  if (command === "yesterday") {
    // A window in days, a second link style and a start before today all mean
    // nothing here: yesterday's window is the previous workday's.
    if (days !== undefined || from !== undefined || links !== undefined) return null;
    if (date !== undefined && !isDate(date)) return null;
    return { cmd: "yesterday", date: date ?? null, format: namedFormat };
  }

  return null;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseCommand(argv);
  if (args === null || args.cmd !== "brief") return usage();
  const date = args.date ?? localNow(deps.now(), deps.env.tz).date;
  const board = await deps.board.fetchBoard(deps.env.owner, deps.env.number);
  const b = brief(board.items, date);
  deps.out(args.format === "json" ? jsonText(b, args.links) : `${renderBrief(b, args.links)}\n`);
  return 0;
}

/**
 * `zya calendar`: the Mac's calendar for a window, rendered in the assistant's zone.
 * An export that fails throws, and the message says why: nothing is printed, so a
 * half-window is never mistaken for a quiet one.
 */
export async function runCalendarCli(argv: string[], deps: CalendarCliDeps): Promise<number> {
  const args = parseCommand(argv);
  // A calendar process has no board: `zya brief` here is the wrong command line.
  if (args === null || args.cmd !== "calendar") return usage();
  const snapshot = await deps.calendar({ from: args.from, days: args.days });
  deps.out(renderCalendar(snapshot, deps.tz, args.format));
  return 0;
}

/**
 * `zya yesterday`: the window since the previous workday, read and printed. A
 * notes or comments read that fails throws, and the message says why; a calendar
 * that fails is a line in the report, because the rest of the window happened.
 */
export async function runYesterdayCli(argv: string[], deps: YesterdayCliDeps): Promise<number> {
  const args = parseCommand(argv);
  if (args === null || args.cmd !== "yesterday") return usage();
  const date = args.date ?? localNow(deps.now(), deps.env.tz).date;
  const report = await yesterday({ date, env: deps.env, board: deps.board, calendar: deps.calendar, now: deps.now, fetchFn: deps.fetchFn });
  deps.out(renderYesterday(report, args.format));
  return 0;
}

/**
 * The briefing as JSON: the same strings the text format prints, in the same
 * shape as the Brief, with the renderer's links applied to each of them.
 */
function jsonText(b: Brief, links: Links): string {
  const lines = (ls: readonly string[]): string[] => ls.map((line) => renderText(line, links));
  const json = {
    date: b.date,
    rows: b.rows.map((row) => ({ itemId: row.itemId, text: renderText(row.text, links) })),
    head: lines(b.head),
    tail: lines(b.tail),
    text: renderText(b.text, links),
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** The usage text, on stderr: what was asked for is stdout, this is not it. */
function usage(): number {
  process.stderr.write(USAGE);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

/**
 * The real entry. The command line is checked before anything is loaded: a usage
 * error needs no token, so `zya nope` exits 2 on a machine that has none. An
 * error's message is printed, never its stack: the message is the whole story.
 */
async function main(argv: string[]): Promise<number> {
  const args = parseCommand(argv);
  if (args === null) return usage();
  try {
    if (args.cmd === "calendar") {
      // No env file: a calendar read needs no token, and the zone is the only
      // setting it has, from the same constant every other reader of ASSISTANT_TZ uses.
      return await runCalendarCli(argv, {
        calendar: (request) => exportCalendar({ ...request, app: appFromEnv() }, MAC_DEPS),
        out: (s) => void process.stdout.write(s),
        tz: TZ,
      });
    }
    const env = loadEnv();
    const deps = {
      board: createBoardClient(env.token),
      now: () => new Date(),
      out: (s: string) => void process.stdout.write(s),
      env,
    };
    if (args.cmd === "yesterday") {
      // The same bundle and the same window shape `zya calendar` opens.
      return await runYesterdayCli(argv, {
        ...deps,
        calendar: (request) => exportCalendar({ ...request, app: appFromEnv() }, MAC_DEPS),
      });
    }
    return await runCli(argv, deps);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }
}
