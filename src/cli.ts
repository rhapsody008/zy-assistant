// The CLI: read the board, apply the rules, print what they say. It changes
// nothing, so it needs no store, no Slack and no scheduler.
//
// Every dependency is injected (the board, the clock, the sink, the env), so the
// whole command runs in a test without a network, a real clock or a token. The
// entry point at the bottom of the file is the only part that touches process.

import { parseArgs } from "node:util";
import { brief, type Brief } from "./brief.ts";
import { loadEnv, type Env } from "./env.ts";
import { errMessage } from "./errors.ts";
import { createBoardClient, type BoardSource } from "./github.ts";
import { renderBrief, renderText, type Links } from "./render.ts";
import { localNow } from "./time.ts";

export interface CliDeps {
  board: BoardSource;
  now: () => Date;
  out: (s: string) => void;
  env: Env;
}

type Format = "md" | "json";

/** What a flag may say. Anything else is a usage error, never a silent default. */
const FORMATS: readonly Format[] = ["md", "json"];
const LINKS: readonly Links[] = ["md", "plain", "slack"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const USAGE = `zya: a read-only view of ZY's board

  zya brief [--date YYYY-MM-DD] [--format md|json] [--links md|plain|slack]

  brief   the morning briefing of a day (default: today), as text or as JSON
  links   how a row's link and emphasis are written: markdown (default), plain
          text for a terminal, or the Slack markup the briefing is built in
`;

interface Args {
  date: string | null; // null: today
  format: Format;
  links: Links;
}

/** One of the named values, or null: a typo is a usage error, not a default. */
function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T | null {
  if (value === undefined) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
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

/** `zya brief`'s arguments, or null when the command line is not one. */
function parseBrief(argv: string[]): Args | null {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { date: { type: "string" }, format: { type: "string" }, links: { type: "string" } },
    });
  } catch {
    return null; // an unknown flag, or one with no value
  }
  const [command, ...rest] = parsed.positionals;
  if (command !== "brief" || rest.length > 0) return null;
  const { date, format, links } = parsed.values;
  if (date !== undefined && !isDate(date)) return null;
  const namedFormat = oneOf(FORMATS, format, "md");
  const namedLinks = oneOf(LINKS, links, "md");
  if (namedFormat === null || namedLinks === null) return null;
  return { date: date ?? null, format: namedFormat, links: namedLinks };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseBrief(argv);
  if (args === null) return usage();
  const date = args.date ?? localNow(deps.now(), deps.env.tz).date;
  const board = await deps.board.fetchBoard(deps.env.owner, deps.env.number);
  const b = brief(board.items, date);
  deps.out(args.format === "json" ? jsonText(b, args.links) : `${renderBrief(b, args.links)}\n`);
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
  if (parseBrief(argv) === null) return usage();
  try {
    const env = loadEnv();
    return await runCli(argv, {
      board: createBoardClient(env.token),
      now: () => new Date(),
      out: (s) => void process.stdout.write(s),
      env,
    });
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return 1;
  }
}
