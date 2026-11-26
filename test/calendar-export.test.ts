// The Mac's half of `zya calendar`, without a Mac: `open` is a fake, the snapshot
// is a string, and the temp directory is a name. Synthetic names only
// ("demo.example"), and the event ids the Mac would derive.
//
// Two things are checked of every failure as well as of every success: that the
// temp directory is removed whole (files and all), and that the message says what
// the app said. A directory left in TMPDIR holds a meeting title, and an empty line
// is no diagnosis.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appFromEnv,
  DEFAULT_APP,
  exportCalendar,
  renderCalendar,
  type CalendarRequest,
  type ExportDeps,
} from "../src/calendar-export.ts";
import { parseSnapshot } from "../src/calendar.ts";
import { runCalendarCli, type CalendarCliDeps } from "../src/cli.ts";

/** The fixed clock: ten minutes after the fixture's generatedAt. */
const NOW = new Date("2026-12-01T02:25:03Z");

const APP = "/Applications/zy-calendar-export.app";

/** What the fake mkdtemp hands out, and the two files the export makes inside it. */
const DIR = "/tmp/zy-calendar-export-test";
const OUT = join(DIR, "out");
const ERR = join(DIR, "err");

/**
 * The app's own line when the permission was never granted: one line, naming the
 * state and never a title.
 */
const DENIED = "zy-calendar-export: no calendar access (denied)";

/** One event as the Mac writes it, with whatever the test changes. */
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "0000000000000001",
    start: "2026-12-01T01:00:00Z", // 09:00 in Singapore
    end: "2026-12-01T02:00:00Z", // 10:00
    allDay: false,
    title: "Acme weekly sync",
    domains: ["acme.example"],
    attendees: 6,
    status: "accepted",
    ...over,
  };
}

/**
 * A two-day Singapore window (midnight 1 December to midnight 3 December) with
 * three meetings: an all-day one, one on the first day and one on the second. In
 * UTC the all-day one is on 30 November, which is the day the render's zone decides.
 */
const FIXTURE = JSON.stringify({
  v: 2,
  tz: "Asia/Singapore",
  generatedAt: "2026-12-01T02:15:03Z",
  window: { start: "2026-11-30T16:00:00Z", end: "2026-12-02T16:00:00Z" },
  events: [
    event(),
    event({
      id: "0000000000000002",
      start: "2026-11-30T16:00:00Z",
      end: "2026-12-01T16:00:00Z",
      allDay: true,
      title: "Offsite",
      domains: [],
      attendees: 0,
      status: "none",
    }),
    event({
      id: "0000000000000003",
      start: "2026-12-02T00:30:00Z", // 08:30 in Singapore
      end: "2026-12-02T01:15:00Z",
      title: "Globex 1:1",
      domains: ["globex.example", "acme.example"],
      attendees: 2,
      status: "tentative",
    }),
  ],
});

/** The export's request, with whatever the test changes. */
function request(over: Partial<CalendarRequest> = {}): CalendarRequest {
  return { from: 0, days: 3, app: APP, ...over };
}

interface Fake {
  deps: ExportDeps;
  /** Every command the export ran, in order, with its whole argument list. */
  runs: Array<{ cmd: string; args: string[] }>;
  /** The files it created, and at which mode. */
  created: Array<{ path: string; mode: number }>;
  /** The paths it removed, in order: the export's own directory, once. */
  removed: string[];
  /** What is left in the file system the fake models: empty after a run. */
  files: Map<string, string>;
}

/**
 * The world as an export sees it: `open` records its command line, writes the
 * snapshot the app would have printed, and answers `code`; the temp directory is
 * one name, and the two files are entries in a map until they are removed.
 */
function fakeExport(files: { out?: string; err?: string } = {}, code = 0): Fake {
  const runs: Fake["runs"] = [];
  const created: Fake["created"] = [];
  const removed: string[] = [];
  const contents = new Map([
    [OUT, ""],
    [ERR, ""],
  ]);
  const deps: ExportDeps = {
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      // The app writes its two files while open waits for it.
      contents.set(OUT, files.out ?? "");
      contents.set(ERR, files.err ?? "");
      return code;
    },
    tmpDir: () => DIR,
    createFile: (path, mode) => {
      created.push({ path, mode });
      contents.set(path, "");
    },
    readFile: (path) => contents.get(path) ?? "",
    rm: (path) => {
      removed.push(path);
      // Recursive, as MAC_DEPS.rm is: the directory takes its files with it.
      for (const key of [...contents.keys()]) if (key.startsWith(path)) contents.delete(key);
    },
    now: () => NOW,
  };
  return { deps, runs, created, removed, files: contents };
}

// ---- open's command line ----------------------------------------------------

test("the export opens the bundle through LaunchServices, with the window it was asked for", async () => {
  const fake = fakeExport({ out: FIXTURE });
  await exportCalendar(request({ from: 0, days: 3 }), fake.deps);

  assert.deepEqual(fake.runs, [
    {
      cmd: "open",
      args: ["-W", "-n", "--stdout", OUT, "--stderr", ERR, "-a", APP, "--args", "--days", "3"],
    },
  ]);
});

test("--from is passed through, and left out of a window that starts today", async () => {
  const from = fakeExport({ out: FIXTURE });
  await exportCalendar(request({ from: -1, days: 2 }), from.deps);
  assert.deepEqual(from.runs[0].args, [
    "-W",
    "-n",
    "--stdout",
    OUT,
    "--stderr",
    ERR,
    "-a",
    APP,
    "--args",
    "--days",
    "2",
    "--from",
    "-1",
  ]);
});

test("the app is opened with a bundle the caller names, so ZY_CALENDAR_APP can point elsewhere", async () => {
  const fake = fakeExport({ out: FIXTURE });
  await exportCalendar(request({ app: "/opt/other.app" }), fake.deps);
  assert.equal(fake.runs[0].args[fake.runs[0].args.indexOf("-a") + 1], "/opt/other.app");
});

// ---- The snapshot -----------------------------------------------------------

test("the file the app printed is parsed as the snapshot, with the clock passed in", async () => {
  const fake = fakeExport({ out: FIXTURE });
  const snapshot = await exportCalendar(request(), fake.deps);
  assert.deepEqual(snapshot, parseSnapshot(FIXTURE, NOW));
  assert.equal(snapshot.tz, "Asia/Singapore");
  assert.deepEqual(snapshot.events.map((one) => one.title), ["Acme weekly sync", "Offsite", "Globex 1:1"]);
});

test("an export that printed nothing fails with the app's own line, and says no title", async () => {
  const fake = fakeExport({ out: "", err: `${DENIED}\nzy-calendar-export: no calendars matched\n` });
  await assert.rejects(exportCalendar(request(), fake.deps), { message: `calendar export failed: ${DENIED}` });
  // The second line was the app carrying on; the first is the reason.
  assert.deepEqual(fake.removed, [DIR]);
});

test("an open that failed says nothing, so its exit code is the diagnosis", async () => {
  const fake = fakeExport({ out: "", err: "" }, 1);
  await assert.rejects(exportCalendar(request(), fake.deps), { message: "calendar export failed: open exited 1" });
  assert.deepEqual(fake.removed, [DIR]);
});

test("a snapshot the parser refuses is a failure, and the temp directory still goes", async () => {
  const fake = fakeExport({ out: '{"v":1,"generatedAt":"2026-12-01T02:15:03Z","window":{}}' });
  await assert.rejects(exportCalendar(request(), fake.deps), {
    message: "window.start: not a timestamp",
  });
  assert.deepEqual(fake.removed, [DIR]);
});

test("both temp files are mode 600 and the directory is removed after a success", async () => {
  const fake = fakeExport({ out: FIXTURE });
  await exportCalendar(request(), fake.deps);
  assert.deepEqual(fake.created, [
    { path: OUT, mode: 0o600 },
    { path: ERR, mode: 0o600 },
  ]);
  // The directory mkdtemp made, whole: removing the files and leaving the empty
  // directory behind would be one leaked 0700 directory per run.
  assert.deepEqual(fake.removed, [DIR]);
  assert.deepEqual([...fake.files.keys()], [], "nothing of the snapshot is left behind");
});

test("a run that throws removes the temp directory too", async () => {
  const fake = fakeExport({ out: FIXTURE });
  const broken = { ...fake.deps, run: async () => Promise.reject(new Error("spawn open ENOENT")) };
  await assert.rejects(exportCalendar(request(), broken), { message: "spawn open ENOENT" });
  assert.deepEqual(fake.removed, [DIR]);
});

test("a second file that cannot be made is still a directory to remove", async () => {
  const fake = fakeExport({ out: FIXTURE });
  let made = 0;
  const broken = {
    ...fake.deps,
    createFile: (path: string, mode: number) => {
      made += 1;
      if (made === 2) throw new Error(`EACCES: permission denied, open '${path}'`);
      fake.deps.createFile(path, mode);
    },
  };
  await assert.rejects(exportCalendar(request(), broken), { message: /^EACCES/ });
  assert.deepEqual(fake.removed, [DIR], "the first file goes with the directory");
});

test("a cleanup that fails is the error, not something swallowed", async () => {
  const fake = fakeExport({ out: FIXTURE });
  const broken = {
    ...fake.deps,
    rm: () => {
      throw new Error("EACCES: permission denied, rm");
    },
  };
  await assert.rejects(exportCalendar(request(), broken), { message: /^EACCES: permission denied, rm$/ });
});

// ---- The bundle -------------------------------------------------------------

test("the bundle is the one this repo builds, unless ZY_CALENDAR_APP names another", () => {
  assert.equal(
    DEFAULT_APP,
    join(homedir(), "zyworkspace", "gitrepo", "zy-assistant", "mac", "calendar", "zy-calendar-export.app"),
  );
  assert.equal(appFromEnv({}), DEFAULT_APP);
  assert.equal(appFromEnv({ ZY_CALENDAR_APP: "" }), DEFAULT_APP);
  assert.equal(appFromEnv({ ZY_CALENDAR_APP: "/opt/other.app" }), "/opt/other.app");
});

// ---- The render -------------------------------------------------------------

test("the render groups meetings under their local day, all-day ones without a time", () => {
  const snapshot = parseSnapshot(FIXTURE, NOW);
  assert.equal(
    renderCalendar(snapshot, "Asia/Singapore", "md"),
    [
      "## Tue 1 Dec",
      "- all day Offsite",
      "- 09:00-10:00 Acme weekly sync (accepted, 6 attendees, acme.example)",
      "## Wed 2 Dec",
      "- 08:30-09:15 Globex 1:1 (tentative, 2 attendees, globex.example, acme.example)",
      "",
    ].join("\n"),
  );
});

test("the zone is the reader's: the same snapshot in UTC puts a day boundary elsewhere", () => {
  const snapshot = parseSnapshot(FIXTURE, NOW);
  const utc = renderCalendar(snapshot, "UTC", "md").split("\n");
  assert.deepEqual(utc, [
    "## Mon 30 Nov",
    "- all day Offsite",
    "## Tue 1 Dec",
    "- 01:00-02:00 Acme weekly sync (accepted, 6 attendees, acme.example)",
    "## Wed 2 Dec",
    "- 00:30-01:15 Globex 1:1 (tentative, 2 attendees, globex.example, acme.example)",
    "",
  ]);
});

test("the json format is the same events with their local day and times added", () => {
  const json = JSON.parse(renderCalendar(parseSnapshot(FIXTURE, NOW), "Asia/Singapore", "json")) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    json.map((one) => [one.localDate, one.localStart, one.localEnd]),
    [
      ["2026-12-01", "00:00", "00:00"], // the all-day one: midnight to midnight
      ["2026-12-01", "09:00", "10:00"],
      ["2026-12-02", "08:30", "09:15"],
    ],
  );
  // Nothing the snapshot held is dropped: an id is what a later line names it by.
  assert.deepEqual(json[1], {
    id: "0000000000000001",
    start: "2026-12-01T01:00:00Z",
    end: "2026-12-01T02:00:00Z",
    allDay: false,
    title: "Acme weekly sync",
    domains: ["acme.example"],
    attendees: 6,
    status: "accepted",
    localDate: "2026-12-01",
    localStart: "09:00",
    localEnd: "10:00",
  });
});

test("a window with no meetings renders as nothing in markdown and as an empty list in json", () => {
  const empty = { generatedAt: "2026-12-01T02:15:03Z", window: { start: "", end: "" }, events: [] };
  assert.equal(renderCalendar(empty, "Asia/Singapore", "md"), "");
  assert.equal(renderCalendar(empty, "Asia/Singapore", "json"), "[]\n");
});

// ---- The command ------------------------------------------------------------

/** The CLI's usage error goes to stderr on purpose: this is the sink that catches it. */
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

/** The deps of one `zya calendar` run, the sink it writes to, and the windows it asked for. */
function setup(over: Partial<CalendarCliDeps> = {}): {
  deps: CalendarCliDeps;
  written: string[];
  asked: Array<{ from: number; days: number }>;
} {
  const written: string[] = [];
  const asked: Array<{ from: number; days: number }> = [];
  const deps: CalendarCliDeps = {
    calendar: async (req) => {
      asked.push(req);
      return parseSnapshot(FIXTURE, NOW);
    },
    out: (s) => written.push(s),
    tz: "Asia/Singapore",
  };
  return { deps: { ...deps, ...over }, written, asked };
}

test("zya calendar defaults to three days from today, as markdown", async () => {
  const { deps, written, asked } = setup();
  assert.equal(await runCalendarCli(["calendar"], deps), 0);
  assert.deepEqual(asked, [{ from: 0, days: 3 }]);
  assert.equal(written.join(""), renderCalendar(parseSnapshot(FIXTURE, NOW), "Asia/Singapore", "md"));
  assert.match(written.join(""), /^## Tue 1 Dec\n/);
});

test("--days, --from and --format reach the export and the render", async () => {
  const { deps, written, asked } = setup();
  assert.equal(await runCalendarCli(["calendar", "--days", "14", "--from", "-14", "--format", "json"], deps), 0);
  assert.deepEqual(asked, [{ from: -14, days: 14 }]);
  const json = JSON.parse(written.join("")) as Array<{ localDate: string }>;
  assert.equal(json.length, 3);
});

test("a command line that is not `zya calendar`'s is a usage error, and asks the Mac nothing", async () => {
  const bad = [
    [],
    ["calendar", "--days", "0"], // one day is the least a window can be
    ["calendar", "--days", "15"],
    ["calendar", "--days", "3.5"],
    ["calendar", "--days", "three"],
    ["calendar", "--from", "1"], // the window starts today or earlier
    ["calendar", "--from", "-15"],
    ["calendar", "--format", "yaml"],
    ["calendar", "--date", "2026-12-01"], // the brief's flag, not this command's
    ["calendar", "extra"],
    ["brief"], // a brief process has no export to run
  ];
  for (const argv of bad) {
    const { deps, written, asked } = setup();
    const { code, err } = await withStderr(() => runCalendarCli(argv, deps));
    assert.equal(code, 2, `${argv.join(" ")} must exit 2`);
    assert.deepEqual(written, [], `${argv.join(" ")} must print nothing`);
    assert.deepEqual(asked, [], `${argv.join(" ")} must not export anything`);
    assert.match(err, /zya calendar \[--days N\]/);
  }
});

test("a failed export is an error with its message, and prints no half-window", async () => {
  const { deps, written } = setup({
    calendar: async () => {
      throw new Error(`calendar export failed: ${DENIED}`);
    },
  });
  await assert.rejects(runCalendarCli(["calendar"], deps), { message: `calendar export failed: ${DENIED}` });
  assert.deepEqual(written, []);
});
