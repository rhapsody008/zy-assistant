// `zya yesterday` without a network, a Mac or a real clock: the board is
// FakeBoard, the calendar and the network are functions handed in, and the window
// is read from its two ends. Synthetic names only: "Acme", "Globex", "demo/notes".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CalendarSnapshot } from "../src/calendar.ts";
import { runYesterdayCli, type YesterdayCliDeps } from "../src/cli.ts";
import type { Env } from "../src/env.ts";
import type { FetchLike } from "../src/github.ts";
import type { Item } from "../src/rules.ts";
import { yesterday, yesterdayWindow, type Yesterday } from "../src/yesterday.ts";
import { item } from "./board.ts";
import { FakeBoard } from "./fakes.ts";

/** A Monday: its report covers Friday, Saturday and Sunday. */
const MONDAY = "2026-11-30";

/** The window that Monday covers, in the assistant's zone: Friday 00:00 to Monday 00:00. */
const FROM = "2026-11-26T16:00:00.000Z";
const UNTIL = "2026-11-29T16:00:00.000Z";

const NOTES = "demo/notes";

const ENV: Env = { token: "test", owner: "rhapsody008", number: 1, notesRepo: NOTES, tz: "Asia/Singapore" };

/** The two lists one window asks for: the notes repo's commits, and its comments. */
const commitsUrl = (from: string, until: string): string =>
  `https://api.github.com/repos/${NOTES}/commits?since=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}&per_page=100`;
const commentsUrl = (since: string): string =>
  `https://api.github.com/repos/${NOTES}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`;

const COMMITS_URL = commitsUrl(FROM, UNTIL);
const COMMENTS_URL = commentsUrl(FROM);
const commitUrl = (sha: string): string => `https://api.github.com/repos/${NOTES}/commits/${sha}`;

/** An item of the demo notes repo. */
function work(id: string, updatedAt: string, over: Partial<Item> = {}): Item {
  return item({ id, ref: `notes#${id}`, title: `Work ${id}`, url: `https://github.com/${NOTES}/issues/${id}`, updatedAt, ...over });
}

/** Friday 10:00, Saturday 10:00 and Sunday 10:00 in Singapore. */
const FRIDAY = work("70", "2026-11-27T02:00:00.000Z");
const SATURDAY = work("74", "2026-11-28T02:00:00.000Z");
const SUNDAY = work("73", "2026-11-29T02:00:00.000Z");
/** Thursday 10:00: before the window, so the week before is not in this report. */
const THURSDAY = work("71", "2026-11-26T02:00:00.000Z");
/** Monday 00:00 exactly: the window ends where this begins. */
const MIDNIGHT = work("75", UNTIL);
/** A pull request: the board holds them, and one that moved moved on its own url. */
const PULL = item({
  id: "76",
  ref: "demo#5",
  title: "Fix the export",
  url: "https://github.com/demo/demo/pull/5",
  updatedAt: "2026-11-28T03:00:00.000Z", // Saturday 11:00
});
/** A draft: its url is the project's, so no issue stands behind it. */
const DRAFT = item({
  id: "72",
  ref: "draft",
  title: "Draft idea",
  url: "https://github.com/users/rhapsody008/projects/1",
  updatedAt: "2026-11-27T02:00:00.000Z",
});

const BOARD = [FRIDAY, SATURDAY, SUNDAY, THURSDAY, MIDNIGHT, PULL];

/** One meeting, at 09:00 on the Friday of the window. */
const SNAPSHOT: CalendarSnapshot = {
  generatedAt: "2026-11-27T02:10:00Z",
  window: { start: FROM, end: UNTIL },
  events: [
    {
      id: "0000000000000001",
      start: "2026-11-27T01:00:00Z",
      end: "2026-11-27T02:00:00Z",
      allDay: false,
      title: "Acme weekly sync",
      domains: ["acme.example"],
      attendees: 6,
      status: "accepted",
    },
  ],
};

/** One commit as the commits list carries it. */
function listed(sha: string, message: string): Record<string, unknown> {
  return { sha, html_url: `https://github.com/${NOTES}/commit/${sha}`, commit: { message, committer: { date: "2026-11-27T02:00:00.000Z" } } };
}

interface Setup {
  /** The day the report ends on; Monday unless a test says otherwise. */
  date?: string;
  routes?: Record<string, unknown>;
  /** When set, the calendar export throws this: a Mac that would not read. */
  failCalendar?: string;
  items?: Item[];
}

/** One run's deps, the sink it wrote to, and every url and calendar window it asked for. */
function setup(over: Setup = {}): {
  date: string;
  deps: YesterdayCliDeps;
  written: string[];
  urls: string[];
  calendarRequests: Array<{ from: number; days: number }>;
} {
  const date = over.date ?? MONDAY;
  const written: string[] = [];
  const urls: string[] = [];
  const calendarRequests: Array<{ from: number; days: number }> = [];
  const board = new FakeBoard();
  board.board.items = over.items ?? BOARD;
  // No notes and no comments unless a test says what happened: the answers it did
  // not plan for are a failed assertion, not a quiet empty report. The urls are the
  // ones this date's window makes, so a report of another day asks its own.
  const window = yesterdayWindow(date, ENV.tz);
  const routes: Record<string, unknown> = {
    [commitsUrl(window.from, window.until)]: [],
    [commentsUrl(window.from)]: [],
    ...over.routes,
  };
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    assert.ok(url in routes, `no fake answer for ${url}`);
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  };
  return {
    date,
    deps: {
      board,
      calendar: async (request) => {
        calendarRequests.push(request);
        if (over.failCalendar !== undefined) throw new Error(over.failCalendar);
        return SNAPSHOT;
      },
      // 09:00 on the Monday: the clock decides the date the same way `zya brief`'s does.
      now: () => new Date(`${MONDAY}T01:00:00Z`),
      out: (s) => written.push(s),
      env: ENV,
      fetchFn,
    },
    written,
    urls,
    calendarRequests,
  };
}

/** The report itself, straight from `yesterday`: the object the renderer is handed. */
function collect(run: ReturnType<typeof setup>): Promise<Yesterday> {
  const { deps, date } = run;
  return yesterday({ date, env: ENV, board: deps.board, calendar: deps.calendar, now: deps.now, fetchFn: deps.fetchFn });
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

test("Monday covers Friday, Saturday and Sunday, and nothing after its own midnight", async () => {
  const run = setup();
  const report = await collect(run);

  assert.deepEqual(report.window, { from: FROM, until: UNTIL, tz: "Asia/Singapore" });
  // Thursday is the week before, and Monday 00:00 already belongs to the day the
  // window ends on. The pull request moved inside the window like any item does.
  assert.deepEqual(report.board.map((update) => update.ref), ["notes#70", "notes#74", "notes#73", "demo#5"]);
  assert.deepEqual(run.calendarRequests, [{ from: -3, days: 3 }], "the Mac is asked for the same three days");
});

test("the notes commits are grouped into the note folders their files are in", async () => {
  const run = setup({
    routes: {
      [COMMITS_URL]: [listed("aaa1", "Acme: sizing sent"), listed("bbb2", "Globex: intro call")],
      [commitUrl("aaa1")]: { files: [{ filename: "Accounts/Acme/2026-11-27.md" }] },
      [commitUrl("bbb2")]: { files: [{ filename: "Accounts/Acme/2026-11-24.md" }, { filename: "Partners/Globex/README.md" }] },
    },
  });
  const report = await collect(run);

  assert.deepEqual(
    report.notes.groups.map((group) => [group.folder, group.commits.map((commit) => commit.sha)]),
    [
      ["Accounts/Acme", ["aaa1", "bbb2"]],
      ["Partners/Globex", ["bbb2"]],
    ],
  );
  assert.deepEqual(report.notes.groups[0].commits.map((commit) => commit.message), ["Acme: sizing sent", "Globex: intro call"]);
  assert.equal(report.notes.truncated, false);
});

test("a comment is reported under the item its issue names", async () => {
  const run = setup({
    routes: {
      [COMMENTS_URL]: [
        {
          html_url: `https://github.com/${NOTES}/issues/70#issuecomment-1`,
          issue_url: "https://api.github.com/repos/demo/notes/issues/70",
          created_at: "2026-11-27T03:00:00.000Z",
          body: "sizing is with them",
          user: { login: "octocat" },
        },
      ],
    },
  });
  const report = await collect(run);

  assert.deepEqual(report.comments, [
    {
      issueUrl: "https://api.github.com/repos/demo/notes/issues/70",
      author: "octocat",
      createdAt: "2026-11-27T03:00:00.000Z",
      body: "sizing is with them",
      url: `https://github.com/${NOTES}/issues/70#issuecomment-1`,
      ref: "notes#70",
    },
  ]);
  // One repo for the board's issues and one repo of notes: no pull request is asked.
  assert.deepEqual(run.urls, [COMMENTS_URL, COMMITS_URL]);
});

test("the markdown is four sections, the calendar's days under its own", async () => {
  const run = setup();
  assert.equal(await runYesterdayCli(["yesterday", "--date", MONDAY], run.deps), 0);

  assert.deepEqual(run.written.join("").split("\n"), [
    "# Yesterday, Sun 29 Nov",
    "window Fri 27 Nov 00:00 – Mon 30 Nov 00:00 (Asia/Singapore)",
    "## Calendar",
    "### Fri 27 Nov",
    "- 09:00-10:00 Acme weekly sync (accepted, 6 attendees, acme.example)",
    "## Board updates",
    `- [notes#70](https://github.com/${NOTES}/issues/70) Work 70 (updated Fri 27 Nov 10:00)`,
    `- [notes#74](https://github.com/${NOTES}/issues/74) Work 74 (updated Sat 28 Nov 10:00)`,
    `- [notes#73](https://github.com/${NOTES}/issues/73) Work 73 (updated Sun 29 Nov 10:00)`,
    "- [demo#5](https://github.com/demo/demo/pull/5) Fix the export (updated Sat 28 Nov 11:00)",
    "## Comments",
    "- no comments",
    "## Notes commits",
    "- no commits",
    "",
  ]);
});

test("a calendar the Mac would not read is a line, and the rest of the window still prints", async () => {
  const run = setup({ failCalendar: "calendar export failed: no calendar access (denied)" });
  assert.equal(await runYesterdayCli(["yesterday", "--date", MONDAY], run.deps), 0);

  const md = run.written.join("");
  assert.match(md, /## Calendar\n- calendar: unavailable \(calendar export failed: no calendar access \(denied\)\)\n## Board updates/);
  assert.ok(md.includes(`- [notes#70](https://github.com/${NOTES}/issues/70) Work 70 (updated Fri 27 Nov 10:00)`));
  assert.ok(md.includes("## Comments\n- no comments"));
  assert.ok(md.includes("## Notes commits\n- no commits"));
});

test("a report of an earlier day counts its calendar window from today, not from its own date", async () => {
  // The clock says Monday 30 November; the report is of Wednesday 25 November, so
  // its window is Tuesday the 24th alone: six days back from today, one day long.
  const run = setup({ date: "2026-11-25" });
  assert.equal(await runYesterdayCli(["yesterday", "--date", "2026-11-25"], run.deps), 0);

  assert.deepEqual(run.calendarRequests, [{ from: -6, days: 1 }], "the export counts its days from the clock's today");
  assert.equal(run.written.join("").split("\n")[0], "# Yesterday, Tue 24 Nov");
});

test("a window the export cannot reach is a calendar line, not other days under this heading", async () => {
  // Three weeks back: past the fourteen days an export covers.
  const old = setup({ date: "2026-11-10" });
  assert.equal(await runYesterdayCli(["yesterday", "--date", "2026-11-10"], old.deps), 0);
  assert.deepEqual(old.calendarRequests, [], "the Mac is not asked for days it cannot reach");
  assert.match(
    old.written.join(""),
    /## Calendar\n- calendar: unavailable \(the window starts more than 14 days back, past what an export covers\)/,
  );
  assert.ok(old.written.join("").includes("## Board updates"), "the other sections still print");

  // Two days ahead: the window ends after today, and an export reaches no further.
  const ahead = setup({ date: "2026-12-02" });
  assert.equal(await runYesterdayCli(["yesterday", "--date", "2026-12-02"], ahead.deps), 0);
  assert.deepEqual(ahead.calendarRequests, []);
  assert.match(ahead.written.join(""), /- calendar: unavailable \(the window ends after today, and an export reaches no further\)/);
});

test("a draft is an update like any other, and its url asks no repo for comments", async () => {
  const run = setup({ items: [DRAFT, FRIDAY] });
  const report = await collect(run);

  assert.deepEqual(report.board.map((update) => update.ref), ["draft", "notes#70"]);
  assert.deepEqual(report.comments, [], "a draft has nowhere to comment");
  assert.deepEqual(report.notes.groups, []);
  // The draft's url is the project's: parsed as an issue it would have asked for a
  // repo this fake has no answer for.
  assert.deepEqual(run.urls, [COMMENTS_URL, COMMITS_URL]);
});

test("as JSON the report is the report, and the date defaults to the clock's day", async () => {
  const run = setup({
    routes: {
      [COMMITS_URL]: [listed("aaa1", "Acme: sizing sent")],
      [commitUrl("aaa1")]: { files: [{ filename: "Events/Offsite/README.md" }] },
    },
  });
  assert.equal(await runYesterdayCli(["yesterday", "--format", "json"], run.deps), 0);

  const json = JSON.parse(run.written.join("")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["date", "window", "calendar", "board", "comments", "notes"]);
  assert.equal(json.date, MONDAY, "09:00 on the 30th, in the env's zone");
  assert.deepEqual(json.window, { from: FROM, until: UNTIL, tz: "Asia/Singapore" });
  assert.deepEqual(
    (json.board as Array<{ ref: string }>).map((update) => update.ref),
    ["notes#70", "notes#74", "notes#73", "demo#5"],
  );
  assert.deepEqual(json.notes, {
    truncated: false,
    groups: [
      {
        folder: "Events/Offsite",
        commits: [
          {
            sha: "aaa1",
            message: "Acme: sizing sent",
            date: "2026-11-27T02:00:00.000Z",
            url: `https://github.com/${NOTES}/commit/aaa1`,
            folders: ["Events/Offsite"],
          },
        ],
      },
    ],
  });
  assert.deepEqual((json.calendar as { snapshot: CalendarSnapshot }).snapshot.events.length, 1);
});

test("a command line that is not one is a usage error: 2, usage on stderr, nothing on stdout", async () => {
  const bad = [
    ["yesterday", "--days", "3"], // the window is the previous workday's, not a count of days
    ["yesterday", "--from", "-1"],
    ["yesterday", "--links", "md"],
    ["yesterday", "--date", "30-11-2026"],
    ["yesterday", "--date", "2026-11-31"],
    ["yesterday", "extra"],
  ];
  for (const argv of bad) {
    const run = setup();
    const { code, err } = await withStderr(() => runYesterdayCli(argv, run.deps));
    assert.equal(code, 2, `${argv.join(" ")} must exit 2`);
    assert.deepEqual(run.written, [], `${argv.join(" ")} must print nothing`);
    assert.match(err, /zya yesterday \[--date YYYY-MM-DD\]/);
  }
});
