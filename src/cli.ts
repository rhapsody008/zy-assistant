// The CLI: read the board, apply the rules, print what they say; read the Mac's
// calendar, print what it holds; report what happened since the previous workday;
// and, with `update`, write one item's fields and its comment to the board, and
// with `note`, one note as an entry in the notes repo. The reads change nothing,
// and nothing else here does: no store, no scheduler.
//
// Every dependency is injected (the board, the calendar export, the clock, the sink,
// the env, the network), so the whole command runs in a test without a network, a
// real clock, a Calendar or a token. The entry point at the bottom of the file is
// the only part that touches process.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { brief, type Brief } from "./brief.ts";
import { appFromEnv, exportCalendar, MAC_DEPS, renderCalendar } from "./calendar-export.ts";
import type { CalendarSnapshot } from "./calendar.ts";
import { loadEnv, type Env } from "./env.ts";
import { errMessage } from "./errors.ts";
import { createBoardClient, type BoardSource, type FetchLike } from "./github.ts";
import { writeNote } from "./note.ts";
import { createNotesClient, type NotesClient } from "./notes.ts";
import { renderBrief, renderText, type Links } from "./render.ts";
import { validateNote, type Note } from "./scribe.ts";
import { localNow, TZ } from "./time.ts";
import { applyUpdate, isDate, planUpdate, publicOp, type UpdateArgs } from "./update.ts";
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

/**
 * What `zya update` needs: the board, read once for the plan and written for the
 * fields, the sink, and the env that names the board. No clock: an update writes
 * what it was told to write, and has no date of its own.
 */
export interface UpdateCliDeps {
  board: BoardSource;
  out: (s: string) => void;
  env: Env;
}

/**
 * What `zya note` needs: the notes repo, the JSON the note arrives as, and the
 * sink. No board, no clock, no env: the note says its own date and its own folder.
 */
export interface NoteCliDeps {
  notes: NotesClient;
  stdin: () => Promise<string>;
  out: (s: string) => void;
}

type Format = "md" | "json";

/** What a flag may say. Anything else is a usage error, never a silent default. */
const FORMATS: readonly Format[] = ["md", "json"];
const LINKS: readonly Links[] = ["md", "plain", "raw"];

/** The window a `zya calendar` run may ask for: whole days, and a fortnight back. */
const DAYS_MAX = 14;
const FROM_MIN = -CALENDAR_DAYS_BACK;

const USAGE = `zya: ZY's board, notes and calendar: the reads print, update writes to
     the board, and note writes to the notes repo

  zya help
  zya brief [--date YYYY-MM-DD] [--format md|json] [--links md|plain|raw]
  zya calendar [--days N] [--from N] [--format md|json]
  zya yesterday [--date YYYY-MM-DD] [--format md|json]
  zya update --ref R [--status S] [--target D|none] [--next-touch D|none]
             [--next-action T] [--waiting-on T] [--comment T] [--dry-run]
  zya note [--dry-run]

  help      this text: every command and what its flags do
  brief     the morning briefing of a day (default: today), as text or as JSON
  links     how a row's link and emphasis are written: markdown (default), plain
            text for a terminal, or raw, which keeps the briefing's own markup
            (<url|ref> and *emphasis*) exactly as the rules wrote it
  calendar  the Mac's calendar, read through Calendar.app: N days (1..${DAYS_MAX},
            default 3) from today, or from N days before today (--from ${FROM_MIN}..0,
            default 0), as markdown (default) or as JSON
  yesterday the board updates, their comments, the notes-repo commits and the
            meetings since the previous workday (a Monday covers the weekend),
            as markdown (default) or as JSON
  update    the fields of one board item, and a comment on its issue: the item is
            its project item id, or a ref (demo#52) the board has exactly one of.
            A date is cleared with "none", a text with an empty string. At least
            one field change or a comment is required, and a run with neither is a
            usage error. It writes unless --dry-run is given, which prints the
            plan and writes nothing; a run prints the writes it confirmed, and the
            one it could not confirm, which may have landed: check the item before
            retrying
  note      one note, as JSON on stdin, written into the notes repo as one entry
            under its folder's Log, newest first. The folder is one the repo lists,
            or a new Accounts/<name>. A run prints the folder, the README's path,
            the entry and the commit's url; --dry-run prints the same, with url null,
            and writes nothing
`;

/** The commands, each already checked: what a run is given, never a flag to re-read. */
type Command =
  | { cmd: "brief"; date: string | null; format: Format; links: Links } // date null: today
  | { cmd: "calendar"; from: number; days: number; format: Format }
  | { cmd: "yesterday"; date: string | null; format: Format } // date null: today
  | { cmd: "update"; dryRun: boolean; update: UpdateArgs }
  | { cmd: "note"; dryRun: boolean }
  | { cmd: "help" };

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
        ref: { type: "string" },
        status: { type: "string" },
        target: { type: "string" },
        "next-touch": { type: "string" },
        "next-action": { type: "string" },
        "waiting-on": { type: "string" },
        comment: { type: "string" },
        "dry-run": { type: "boolean" },
      },
    });
  } catch {
    return null; // an unknown flag, or one with no value
  }
  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0) return null;
  // `zya help` takes no option at all, and a flag on it was meant for one of the
  // commands: a usage error rather than a page of prose. `parseArgs` fills in only
  // what was supplied, so no keys is no flags.
  if (command === "help") return Object.keys(parsed.values).length === 0 ? { cmd: "help" } : null;
  const { date, format, links, days, from, ref, status, target, comment, "dry-run": dryRun } = parsed.values;
  const nextTouch = parsed.values["next-touch"];
  const nextAction = parsed.values["next-action"];
  const waitingOn = parsed.values["waiting-on"];
  // `zya update`'s flags: none of the three reads has one of them.
  const writeFlags = [ref, status, target, nextTouch, nextAction, waitingOn, comment, dryRun];
  const namedFormat = oneOf(FORMATS, format, "md");
  if (namedFormat === null) return null;

  if (command === "brief") {
    if (days !== undefined || from !== undefined || writeFlags.some((v) => v !== undefined)) return null;
    if (date !== undefined && !isDate(date)) return null;
    const namedLinks = oneOf(LINKS, links, "md");
    if (namedLinks === null) return null;
    return { cmd: "brief", date: date ?? null, format: namedFormat, links: namedLinks };
  }

  if (command === "calendar") {
    if (date !== undefined || links !== undefined || writeFlags.some((v) => v !== undefined)) return null;
    const namedDays = dayCount(days, 1, DAYS_MAX, 3);
    const namedFrom = dayCount(from, FROM_MIN, 0, 0);
    if (namedDays === null || namedFrom === null) return null;
    return { cmd: "calendar", from: namedFrom, days: namedDays, format: namedFormat };
  }

  if (command === "yesterday") {
    // A window in days, a second link style and a start before today all mean
    // nothing here: yesterday's window is the previous workday's.
    if (days !== undefined || from !== undefined || links !== undefined) return null;
    if (writeFlags.some((v) => v !== undefined)) return null;
    if (date !== undefined && !isDate(date)) return null;
    return { cmd: "yesterday", date: date ?? null, format: namedFormat };
  }

  if (command === "update") {
    // An update has no day, no format and no window: those belong to the reads.
    if (date !== undefined || format !== undefined || links !== undefined) return null;
    if (days !== undefined || from !== undefined) return null;
    if (ref === undefined || ref === "") return null;
    const update: UpdateArgs = { ref, status, target, nextTouch, nextAction, waitingOn, comment };
    // Nothing but the item: a run that writes nothing is no update, so it is a
    // usage error rather than a success that did nothing.
    if ([status, target, nextTouch, nextAction, waitingOn, comment].every((value) => value === undefined)) return null;
    return { cmd: "update", dryRun: dryRun ?? false, update };
  }

  if (command === "note") {
    // A note has no day, no format, no window and no board item: the JSON on stdin
    // says everything it writes, and --dry-run is its only flag.
    if (date !== undefined || format !== undefined || links !== undefined) return null;
    if (days !== undefined || from !== undefined) return null;
    if ([ref, status, target, nextTouch, nextAction, waitingOn, comment].some((value) => value !== undefined)) return null;
    return { cmd: "note", dryRun: dryRun ?? false };
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
 * `zya update`: one item's fields, and a comment on its issue. `--dry-run` prints
 * the plan, as it is, and writes nothing; a run prints the result, `failed` and
 * all. A plan that is refused throws before the first write, so a bad date or an
 * unknown option never half happens; a write whose acknowledgement was lost is
 * the result's `failed` and exit 1, because the rest of the plan was not
 * attempted. Either way the JSON is each op's kind, field and value: the ids a
 * write resolves stay in the plan.
 */
export async function runUpdateCli(argv: string[], deps: UpdateCliDeps): Promise<number> {
  const args = parseCommand(argv);
  if (args === null || args.cmd !== "update") return usage();
  const board = await deps.board.fetchBoard(deps.env.owner, deps.env.number);
  const plan = planUpdate(board, args.update);
  if (args.dryRun) {
    deps.out(asJson({ item: plan.item, ops: plan.ops.map(publicOp) }));
    return 0;
  }
  // The plan is applied to the board it was planned against: nothing is looked up twice.
  const result = await applyUpdate(deps.board, plan);
  // `applied` is what the board confirmed; `failed` is the one it was writing when
  // the answer was lost, which may have landed, and the ops after it never ran.
  const shown = {
    applied: result.applied.map(publicOp),
    ...(result.failed === undefined ? {} : { failed: { op: publicOp(result.failed.op), error: result.failed.error } }),
  };
  deps.out(asJson(shown));
  return result.failed === undefined ? 0 : 1;
}

/**
 * The note the JSON says: one scribe-format note, and nothing else. A stdin that is
 * not JSON is refused here, where the message can say so.
 */
function noteFromJson(text: string): Note {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("note: stdin is not JSON");
  }
  return validateNote(value);
}

/**
 * `zya note`: one note as JSON on stdin, one entry into the notes repo. The note is
 * validated before the repo is read, so an invalid one writes nothing, and
 * `--dry-run` prints what would be written and writes nothing either. The output is
 * the folder, the README's path, the entry, and the commit's url (null in a dry run).
 */
export async function runNoteCli(argv: string[], deps: NoteCliDeps): Promise<number> {
  const args = parseCommand(argv);
  if (args === null || args.cmd !== "note") return usage();
  const note = noteFromJson(await deps.stdin());
  deps.out(asJson(await writeNote(deps.notes, note, { dryRun: args.dryRun })));
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

/** The value as the CLI prints it: the shape itself, indented, never a reshaped copy. */
function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The usage text, on stderr: what was asked for is stdout, this is not it. */
function usage(): number {
  process.stderr.write(USAGE);
  return 2;
}

/** The usage text, on stdout and exit 0: `zya help` asked for exactly this. */
function help(): number {
  process.stdout.write(USAGE);
  return 0;
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
  // The one command that needs nothing: no token, no board, no calendar.
  if (args.cmd === "help") return help();
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
    if (args.cmd === "note") {
      // A note writes no board item and reads no board: the board's own settings are
      // left out of the env rather than refused, so a broken PROJECT_NUMBER is not a
      // note's failure. The token and the notes repo come from the same loader as
      // every other command's.
      const { PROJECT_OWNER: _owner, PROJECT_NUMBER: _number, ...notesOnly } = process.env;
      const env = loadEnv(notesOnly);
      return await runNoteCli(argv, {
        notes: createNotesClient({ repo: env.notesRepo, token: env.token }),
        stdin: async () => readFileSync(0, "utf8"),
        out: (s) => void process.stdout.write(s),
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
    if (args.cmd === "update") return await runUpdateCli(argv, deps);
    return await runCli(argv, deps);
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }
}
