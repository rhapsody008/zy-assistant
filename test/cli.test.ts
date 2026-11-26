// The CLI: its command line, its two formats, and the env it reads. No network
// and no real clock: the board is FakeBoard, the clock and the sink are handed in,
// and the env file is a function that returns a string.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, type CliDeps } from "../src/cli.ts";
import { ENV_FILE, loadEnv, type Env } from "../src/env.ts";
import { FakeBoard } from "./fakes.ts";
import { item } from "./board.ts";

const FRIDAY = "2026-11-27";

const ENV: Env = { token: "test", owner: "rhapsody008", number: 1, notesRepo: "rhapsody008/notes", tz: "Asia/Singapore" };

/** A Friday board: one row due today, and the two sections only a Friday has. */
const DUE_TODAY = item({ id: "70", ref: "demo#70", title: "Today", target: FRIDAY });
const PIPELINE = item({ id: "71", ref: "demo#71", title: "Acme POC", stage: "POC", updatedAt: "2026-10-01T00:00:00.000Z" });
const LEARNING = item({ id: "72", ref: "demo#72", title: "Read SICP", track: "Learn", cadence: "Weekly", updatedAt: "2026-11-25T00:00:00.000Z" });

/** The deps of one run, and the sink it writes to. */
function setup(overrides: Partial<CliDeps> = {}): { deps: CliDeps; written: string[] } {
  const written: string[] = [];
  const board = new FakeBoard();
  board.board.items = [DUE_TODAY, PIPELINE, LEARNING];
  const deps: CliDeps = { board, now: () => new Date(`${FRIDAY}T01:00:00.000Z`), out: (s) => written.push(s), env: ENV };
  return { deps: { ...deps, ...overrides }, written };
}

/** Runs the CLI with stderr captured: a usage error is not injected, so it is caught here. */
async function withStderr(run: () => Promise<number>): Promise<{ code: number; err: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), err: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const ZYA = fileURLToPath(new URL("../bin/zya", import.meta.url));

/**
 * The real entry as a process. The environment is scrubbed and HOME points at a
 * directory that does not exist, so no token of this machine can reach the run and
 * no env file can be found: this is the machine-with-nothing-set case.
 */
function zya(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(ZYA, args, {
    encoding: "utf8",
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: join(tmpdir(), "zya-test-no-home") },
  });
  assert.equal(run.error, undefined);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("brief --format json prints the briefing as JSON, Friday sections and all", async () => {
  const { deps, written } = setup();
  assert.equal(await runCli(["brief", "--date", FRIDAY, "--format", "json"], deps), 0);

  const json = JSON.parse(written.join("")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["date", "rows", "head", "tail", "text"]);
  assert.equal(json.date, FRIDAY);

  const rows = json.rows as Array<{ itemId: string; text: string }>;
  assert.deepEqual(rows.map((row) => row.itemId), [DUE_TODAY.id]);
  assert.equal(rows[0].text, `[demo#70](https://github.com/rhapsody008/notes/issues/70) Today: **due today**`);
  assert.deepEqual(rows.map((row) => Object.keys(row)), [["itemId", "text"]]);

  assert.deepEqual(json.head, ["**Morning briefing, Fri 27 Nov**", "**Today**"]);

  const text = json.text as string;
  assert.match(text, /\*\*Pipeline\*\*\n• demo#71 Acme POC: in POC, no update for 57 days/);
  assert.match(text, /\*\*Learning\*\*\n• demo#72 Read SICP: cadence Weekly, last update Wed 25 Nov \(this week\)/);
  assert.deepEqual(json.tail, [
    "**Pipeline**\n• demo#71 Acme POC: in POC, no update for 57 days",
    "**Learning**\n• demo#72 Read SICP: cadence Weekly, last update Wed 25 Nov (this week)",
    "**In progress:** 3",
  ]);
});

test("the date defaults to today in the env's zone", async () => {
  // 02:00 UTC on the 27th is the 26th in Los Angeles and the 27th in Singapore and
  // in UTC: only a CLI that reads the env's zone can answer Thursday's date here.
  const { deps, written } = setup({
    now: () => new Date(`${FRIDAY}T02:00:00.000Z`),
    env: { ...ENV, tz: "America/Los_Angeles" },
  });
  assert.equal(await runCli(["brief", "--format", "json"], deps), 0);
  assert.equal((JSON.parse(written.join("")) as { date: string }).date, "2026-11-26");
});

test("the text format is markdown unless told otherwise", async () => {
  const { deps, written } = setup();
  assert.equal(await runCli(["brief", "--date", FRIDAY], deps), 0);
  const text = written.join("");
  assert.ok(text.includes("[demo#70](https://github.com/rhapsody008/notes/issues/70) Today: **due today**"));
  assert.ok(!text.includes("<https"), "no raw link may survive the default render");
  assert.ok(text.endsWith("\n"));
});

test("--links picks the markup: plain for a terminal, raw for the briefing itself", async () => {
  const plain = setup();
  assert.equal(await runCli(["brief", "--date", FRIDAY, "--links", "plain"], plain.deps), 0);
  assert.ok(plain.written.join("").includes("• demo#70 (https://github.com/rhapsody008/notes/issues/70) Today: due today"));
  assert.ok(!plain.written.join("").includes("*"));

  const raw = setup();
  assert.equal(await runCli(["brief", "--date", FRIDAY, "--links", "raw"], raw.deps), 0);
  assert.ok(
    raw.written.join("").includes("• <https://github.com/rhapsody008/notes/issues/70|demo#70> Today: *due today*"),
  );
});

test("a command line that is not one is a usage error: 2, usage on stderr, nothing on stdout", async () => {
  const bad = [
    ["nope"],
    [],
    ["brief", "--date", "27-11-2026"],
    ["brief", "--date", "2026-02-30"], // the shape of a day, and not one
    ["brief", "--date", "2026-13-45"],
    ["brief", "--date", "2026-1-1"],
    ["brief", "--format", "yaml"],
    ["brief", "--links", "html"],
    ["brief", "--links", "slack"], // the old name of `raw`
    ["brief", "extra"],
  ];
  for (const argv of bad) {
    const { deps, written } = setup();
    const { code, err } = await withStderr(() => runCli(argv, deps));
    assert.equal(code, 2, `${argv.join(" ")} must exit 2`);
    assert.deepEqual(written, [], `${argv.join(" ")} must print nothing`);
    assert.match(err, /zya brief \[--date YYYY-MM-DD\]/);
  }
});

test("a leap day is a day, and prints its own date", async () => {
  const { deps, written } = setup();
  assert.equal(await runCli(["brief", "--date", "2028-02-29", "--format", "json"], deps), 0);
  assert.equal((JSON.parse(written.join("")) as { date: string }).date, "2028-02-29");
});

test("the token is read from the env file when the shell has none, quotes stripped", () => {
  const read: string[] = [];
  const env = loadEnv({}, (path) => {
    read.push(path);
    return `# the token\nGITHUB_TOKEN="ghp_from_file"\n`;
  });
  assert.deepEqual(read, [ENV_FILE]);
  assert.deepEqual(env, {
    token: "ghp_from_file",
    owner: "rhapsody008",
    number: 1,
    notesRepo: "rhapsody008/notes",
    tz: "Asia/Singapore",
  });
});

test("the shell's token wins, and no file is read for it", () => {
  const read: string[] = [];
  const env = loadEnv({ GITHUB_TOKEN: "ghp_from_shell" }, (path) => {
    read.push(path);
    return "GITHUB_TOKEN=ghp_from_file\n";
  });
  assert.equal(env.token, "ghp_from_shell");
  assert.deepEqual(read, []);
});

test("an empty variable is unset, as it was in the bot's config", () => {
  // `PROJECT_OWNER=` in a shell file is a blank line, not an owner; `ASSISTANT_TZ=`
  // is not a zone the formatter can be given.
  const env = loadEnv(
    { GITHUB_TOKEN: "", PROJECT_OWNER: "", PROJECT_NUMBER: "", NOTES_REPO: "", ASSISTANT_TZ: "" },
    () => "GITHUB_TOKEN=ghp_from_file\n",
  );
  assert.deepEqual(env, {
    token: "ghp_from_file",
    owner: "rhapsody008",
    number: 1,
    notesRepo: "rhapsody008/notes",
    tz: "Asia/Singapore",
  });
});

test("every setting can be overridden", () => {
  const env = loadEnv(
    { GITHUB_TOKEN: "t", PROJECT_OWNER: "acme", PROJECT_NUMBER: "7", NOTES_REPO: "acme/notes", ASSISTANT_TZ: "UTC" },
    () => "",
  );
  assert.deepEqual(env, { token: "t", owner: "acme", number: 7, notesRepo: "acme/notes", tz: "UTC" });
});

test("a missing token names the variable, and no error ever carries the value", () => {
  const gone = (): string => {
    throw new Error("ENOENT: no such file or directory");
  };
  assert.throws(() => loadEnv({}, gone), /^Error: GITHUB_TOKEN not set$/);
  // An unset line is no token either: the key is there, the value is not.
  assert.throws(() => loadEnv({}, () => "GITHUB_TOKEN=\n"), /^Error: GITHUB_TOKEN not set$/);

  // The token is read, and the error is about something else: it still must not
  // repeat the value. A token in an error is a token in a bug report.
  assert.throws(
    () => loadEnv({ PROJECT_NUMBER: "zero" }, () => "GITHUB_TOKEN=ghp_secret_value\n"),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.equal(message, "PROJECT_NUMBER must be a positive whole number, got zero");
      assert.ok(!message.includes("ghp_secret_value"), "the message must not repeat the token");
      return true;
    },
  );
});

test("the real entry: a usage error needs no token, and a missing one is one line, exit 1", () => {
  const usage = zya("nope");
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^zya: ZY's board, notes and calendar: the reads print, update writes to\n/);
  assert.match(usage.stderr, /zya brief \[--date YYYY-MM-DD\]/);
  assert.equal(usage.stdout, "");

  // The message alone: no stack, and not the token's name twice over.
  const noToken = zya("brief");
  assert.equal(noToken.status, 1);
  assert.equal(noToken.stderr, "GITHUB_TOKEN not set\n");
  assert.equal(noToken.stdout, "");
});

test("zya help prints the usage on stdout and exits 0: every command and flag is named", () => {
  const { status, stdout, stderr } = zya("help");
  assert.equal(status, 0);
  assert.equal(stderr, "");
  // Each command is in the synopsis (`  zya brief …`) and again, described, below
  // it (`  brief     …`), so both listings have to carry it.
  for (const command of ["help", "brief", "calendar", "yesterday", "update", "note"]) {
    assert.match(stdout, new RegExp(`\\n  zya ${command}( |\\n|$)`), `${command} must be in the synopsis`);
    assert.match(stdout, new RegExp(`\\n  ${command} {1,}\\S`), `${command} must be described`);
  }
  for (const flag of [
    "--date",
    "--format",
    "--links",
    "--days",
    "--from",
    "--ref",
    "--status",
    "--target",
    "--next-touch",
    "--next-action",
    "--waiting-on",
    "--comment",
    "--dry-run",
  ]) {
    assert.ok(stdout.includes(flag), `${flag} must be listed`);
  }
  assert.match(stdout, /md\|plain\|raw/, "the three link shapes are named");
  assert.match(stdout, /update writes to/);
  assert.match(stdout, /note writes to the notes repo/);
});

test("no arguments prints that very listing on stderr, and so does a flag on help: exit 2", () => {
  const help = zya("help");
  const noArgs = zya();
  assert.equal(noArgs.status, 2);
  assert.equal(noArgs.stdout, "");
  assert.equal(noArgs.stderr, help.stdout, "no arguments prints the very same text");

  // `help` takes no flag: a flag on it was meant for a command, so nothing runs.
  const flagged = zya("help", "--date", "2026-11-27");
  assert.equal(flagged.status, 2);
  assert.equal(flagged.stdout, "");
  assert.equal(flagged.stderr, help.stdout);
});
