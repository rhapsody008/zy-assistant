// The calendar snapshot without a Mac or a disk: the parser, the intake's
// outcomes, the freshness, the lines a mode prints and the tick's log lines, with
// the clock passed in. Synthetic names only: "demo.example", and the event ids
// the Mac would derive.
//
// Every rejection is checked for two things at once: the field path it names, and
// that the message repeats nothing the payload says. A title never leaves this
// module, and a domain names a customer.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CalendarIntake,
  calendarFreshnessLine,
  calendarRefreshLine,
  parseSnapshot,
  snapshotLines,
  SNAPSHOT_MAX_BYTES,
  type CalendarState,
} from "../src/calendar.ts";
import { calendarWatcher } from "../src/main.ts";

/** The fixed clock: ten minutes after the fixture's generatedAt. */
const NOW = new Date("2026-12-01T02:25:03Z");

const MINUTE = 60_000;

/** One event as the Mac writes it, with whatever the test changes. */
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "9f2c41d07ab3e6c1",
    start: "2026-12-01T03:00:00Z",
    end: "2026-12-01T04:00:00Z",
    allDay: false,
    title: "Kickoff with demo",
    domains: ["demo.example"],
    attendees: 6,
    status: "accepted",
    ...over,
  };
}

/** The whole file, with whatever the test changes at the top level. */
function snapshotFile(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    generatedAt: "2026-12-01T02:15:03Z",
    window: { start: "2026-11-30T16:00:00Z", end: "2026-12-02T16:00:00Z" },
    events: [event()],
    ...over,
  });
}

/** The file with one event, that event changed. */
function withEvent(over: Record<string, unknown>): string {
  return snapshotFile({ events: [event(over)] });
}

/** One event per index, each with its own id: what 200 events look like. */
function manyEvents(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => event({ id: i.toString(16).padStart(16, "0") }));
}

/** A snapshot generated `minutes` before NOW, in a window that reaches two hours past it. */
function aged(minutes: number): string {
  const at = new Date(NOW.getTime() - minutes * MINUTE);
  return snapshotFile({
    generatedAt: at.toISOString(),
    window: {
      start: new Date(at.getTime() - 10 * 60 * MINUTE).toISOString(),
      end: new Date(at.getTime() + 120 * MINUTE).toISOString(),
    },
  });
}

interface FakeFile {
  intake: CalendarIntake;
  set: (text: string) => void;
  setError: (error: Error) => void;
}

/** A snapshot file the test controls: the text it holds, or the error reading it throws. */
function fakeFile(initial: string): FakeFile {
  let contents: string | Error = initial;
  const intake = new CalendarIntake({
    path: "/var/lib/zy/calendar.json",
    readFile: async () => {
      if (contents instanceof Error) throw contents;
      return contents;
    },
  });
  return {
    intake,
    set: (text) => {
      contents = text;
    },
    setError: (error) => {
      contents = error;
    },
  };
}

/** An fs error with the code the intake reads. */
function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A state that cannot be null: the test has just accepted a snapshot. */
function heldState(intake: CalendarIntake, now: Date): CalendarState {
  const state = intake.current(now);
  assert.ok(state !== null, "a snapshot was accepted, so there is one to read");
  return state;
}

// ---- The parser -------------------------------------------------------------

test("the snapshot the Mac exports parses field by field", () => {
  const snapshot = parseSnapshot(snapshotFile(), NOW);
  assert.equal(snapshot.generatedAt, "2026-12-01T02:15:03Z");
  assert.deepEqual(snapshot.window, { start: "2026-11-30T16:00:00Z", end: "2026-12-02T16:00:00Z" });
  assert.deepEqual(snapshot.events, [
    {
      id: "9f2c41d07ab3e6c1",
      start: "2026-12-01T03:00:00Z",
      end: "2026-12-01T04:00:00Z",
      allDay: false,
      title: "Kickoff with demo",
      domains: ["demo.example"],
      attendees: 6,
      status: "accepted",
    },
  ]);
});

test("text that is not JSON, or not a JSON object, is refused without an echo", () => {
  assert.throws(() => parseSnapshot("{not json", NOW), /^Error: snapshot: not JSON$/);
  assert.throws(() => parseSnapshot("[]", NOW), /^Error: snapshot: not a JSON object$/);
  assert.throws(() => parseSnapshot("null", NOW), /^Error: snapshot: not a JSON object$/);
});

test("a snapshot that is not version 1 is refused", () => {
  assert.throws(() => parseSnapshot(snapshotFile({ v: 2 }), NOW), /^Error: v: not 1$/);
  assert.throws(() => parseSnapshot(snapshotFile({ v: "1" }), NOW), /^Error: v: not 1$/);
  assert.throws(() => parseSnapshot(snapshotFile({ v: undefined }), NOW), /^Error: v: not 1$/);
});

test("a text over 256 KiB is refused before anything parses it", () => {
  const large = "x".repeat(SNAPSHOT_MAX_BYTES + 1);
  assert.throws(() => parseSnapshot(large, NOW), /^Error: snapshot: 262145 bytes, over the 262144 cap$/);
});

test("generatedAt has to be an ISO timestamp with a Z", () => {
  for (const value of ["2026-12-01 02:15:03", "2026-12-01T02:15:03+08:00", "2026-12-01T25:00:00Z", "yesterday", 1]) {
    assert.throws(() => parseSnapshot(snapshotFile({ generatedAt: value }), NOW), /^Error: generatedAt: not a timestamp$/, JSON.stringify(value));
  }
});

test("generatedAt may be up to five minutes ahead, and not a minute more", () => {
  const ahead = (minutes: number): string => new Date(NOW.getTime() + minutes * MINUTE).toISOString();
  assert.equal(parseSnapshot(snapshotFile({ generatedAt: ahead(5) }), NOW).generatedAt, ahead(5), "five minutes is a clock, not a push");
  assert.throws(
    () => parseSnapshot(snapshotFile({ generatedAt: ahead(6) }), NOW),
    /^Error: generatedAt: more than 5 minutes in the future$/,
  );
});

test("the window's bounds are timestamps, and its end is after its start", () => {
  assert.throws(
    () => parseSnapshot(snapshotFile({ window: { start: "2026-11-30", end: "2026-12-02T16:00:00Z" } }), NOW),
    /^Error: window.start: not a timestamp$/,
  );
  assert.throws(() => parseSnapshot(snapshotFile({ window: null }), NOW), /^Error: window: not an object$/);
  for (const end of ["2026-11-30T16:00:00Z", "2026-11-30T15:00:00Z"]) {
    assert.throws(
      () => parseSnapshot(snapshotFile({ window: { start: "2026-11-30T16:00:00Z", end } }), NOW),
      /^Error: window.end: not after window.start$/,
    );
  }
});

test("an event that does not end after it starts is refused", () => {
  assert.throws(
    () => parseSnapshot(withEvent({ end: "2026-12-01T03:00:00Z" }), NOW),
    /^Error: events\[0\]\.end: not after its start$/,
  );
  assert.throws(
    () => parseSnapshot(withEvent({ start: "2026-12-01T04:00:00Z" }), NOW),
    /^Error: events\[0\]\.end: not after its start$/,
  );
});

test("a duplicate id is refused, on the event that repeats it", () => {
  const twice = snapshotFile({ events: [event(), event({ title: "Another one" })] });
  assert.throws(() => parseSnapshot(twice, NOW), /^Error: events\[1\]\.id: duplicate$/);
});

test("an id is 16 hex characters, and anything else is refused without an echo", () => {
  const bad = ["ACME-SECRET", "9f2c41d07ab3e6c", "9F2C41D07AB3E6C1", "9f2c41d07ab3e6c1\n", "", 1];
  for (const id of bad) {
    assert.throws(
      () => parseSnapshot(withEvent({ id }), NOW),
      (err: Error) => {
        assert.match(err.message, /^events\[0\]\.id: not 16 hex characters$/);
        assert.ok(!err.message.includes("ACME-SECRET"), `the message repeats the id: ${err.message}`);
        return true;
      },
      JSON.stringify(id),
    );
  }
  // An id with a newline could forge a log line of its own, and an id is printed.
  assert.equal(parseSnapshot(withEvent({ id: "9f2c41d07ab3e6c1" }), NOW).events[0].id, "9f2c41d07ab3e6c1");
});

test("allDay has to be a boolean", () => {
  for (const value of ["false", 0, null]) {
    assert.throws(() => parseSnapshot(withEvent({ allDay: value }), NOW), /^Error: events\[0\]\.allDay: not a boolean$/);
  }
});

test("attendees has to be a non-negative integer", () => {
  for (const value of [-1, 2.5, "6", null]) {
    assert.throws(
      () => parseSnapshot(withEvent({ attendees: value }), NOW),
      /^Error: events\[0\]\.attendees: not a non-negative integer$/,
      JSON.stringify(value),
    );
  }
  assert.equal(parseSnapshot(withEvent({ attendees: 0 }), NOW).events[0].attendees, 0, "nobody but ZY is a number too");
});

test("status has to be one of the four", () => {
  for (const value of ["maybe", "ACCEPTED", null]) {
    assert.throws(
      () => parseSnapshot(withEvent({ status: value }), NOW),
      /^Error: events\[0\]\.status: not one of accepted, tentative, organizer, none$/,
    );
  }
  for (const status of ["accepted", "tentative", "organizer", "none"]) {
    assert.equal(parseSnapshot(withEvent({ status }), NOW).events[0].status, status);
  }
});

test("domains has to be an array of strings", () => {
  for (const value of ["demo.example", [1], null, { "0": "demo.example" }]) {
    assert.throws(
      () => parseSnapshot(withEvent({ domains: value }), NOW),
      /events\[0\]\.domains: not an array of strings|events\[0\]\.domains\[0\]: not a string/,
    );
  }
  assert.deepEqual(parseSnapshot(withEvent({ domains: [] }), NOW).events[0].domains, [], "a solo meeting has none");
});

test("a title has to be a string", () => {
  for (const value of [42, null, ["Kickoff"]]) {
    assert.throws(() => parseSnapshot(withEvent({ title: value }), NOW), /^Error: events\[0\]\.title: not a string$/);
  }
});

test("the message names the field path and nothing the payload says", () => {
  const four = snapshotFile({
    events: [
      event({ id: "0000000000000001" }),
      event({ id: "0000000000000002" }),
      event({ id: "0000000000000003" }),
      event({ id: "0000000000000004", end: "soon", title: "ACME-SECRET", domains: ["acme-secret.example"] }),
    ],
  });
  assert.throws(
    () => parseSnapshot(four, NOW),
    (err: Error) => {
      assert.match(err.message, /^events\[3\]\.end: not a timestamp$/);
      for (const secret of ["ACME-SECRET", "acme-secret.example", "soon"]) {
        assert.ok(!err.message.includes(secret), `the message repeats ${secret}: ${err.message}`);
      }
      return true;
    },
  );
});

test("a long title is cut to 200 characters rather than refused", () => {
  const long = "a".repeat(300);
  const snapshot = parseSnapshot(withEvent({ title: long }), NOW);
  assert.equal(snapshot.events[0].title.length, 200, "a title is never shown, so the cut costs nothing");
  assert.equal(snapshot.events[0].title, long.slice(0, 200));
});

test("200 events parse, and 201 are refused rather than cut", () => {
  assert.equal(parseSnapshot(snapshotFile({ events: manyEvents(200) }), NOW).events.length, 200);
  assert.throws(
    () => parseSnapshot(snapshotFile({ events: manyEvents(201) }), NOW),
    /^Error: events: 201 events, over the 200 cap$/,
  );
});

test("domains are capped at 20, and each at 100 characters", () => {
  const domains = (n: number): string[] => Array.from({ length: n }, (_, i) => `${i}`.padStart(3, "0") + "demo.example");
  assert.equal(parseSnapshot(withEvent({ domains: domains(20) }), NOW).events[0].domains.length, 20);
  assert.throws(
    () => parseSnapshot(withEvent({ domains: domains(21) }), NOW),
    /^Error: events\[0\]\.domains: 21 domains, over the 20 cap$/,
  );
  const atCap = `${"d".repeat(92)}.example`;
  assert.equal(atCap.length, 100);
  assert.equal(parseSnapshot(withEvent({ domains: [atCap] }), NOW).events[0].domains[0], atCap);
  assert.throws(
    () => parseSnapshot(withEvent({ domains: [`${atCap}x`] }), NOW),
    /^Error: events\[0\]\.domains\[0\]: over 100 characters$/,
  );
});

test("a domain is a lowercase name with at least one dot, and nothing else", () => {
  const bad = ["Demo.Example", "demo", "demo.", ".example", "-demo.example", "demo-.example", "demo..example", "demo example.com", "demo.example/x"];
  for (const domain of bad) {
    assert.throws(
      () => parseSnapshot(withEvent({ domains: [domain] }), NOW),
      /^Error: events\[0\]\.domains\[0\]: not a lowercase domain name$/,
      domain,
    );
  }
  for (const domain of ["demo.example", "a-b.example", "x1.y2.example"]) {
    assert.deepEqual(parseSnapshot(withEvent({ domains: [domain] }), NOW).events[0].domains, [domain], domain);
  }
});

// ---- The intake -------------------------------------------------------------

test("a newer snapshot is accepted and says what it holds", async () => {
  const file = fakeFile(aged(10));
  const refresh = await file.intake.refresh(NOW);
  assert.equal(refresh.kind, "accepted");
  if (refresh.kind !== "accepted") return;
  assert.equal(refresh.events, 1);
  assert.equal(refresh.allDay, 0);
  assert.equal(refresh.snapshot.generatedAt, new Date(NOW.getTime() - 10 * MINUTE).toISOString());
});

test("the all-day count is the all-day events, not the events", async () => {
  const two = snapshotFile({
    events: [event({ id: "0000000000000001", allDay: true }), event({ id: "0000000000000002" })],
  });
  const refresh = await fakeFile(two).intake.refresh(NOW);
  assert.equal(refresh.kind, "accepted");
  if (refresh.kind !== "accepted") return;
  assert.equal(refresh.events, 2);
  assert.equal(refresh.allDay, 1);
});

test("the same push twice is unchanged, and nothing is replaced", async () => {
  const file = fakeFile(aged(10));
  const first = await file.intake.refresh(NOW);
  assert.equal(first.kind, "accepted");
  const before = heldState(file.intake, NOW);

  // Same generatedAt, different body: the Mac said nothing new, so it is no new snapshot.
  const second = await file.intake.refresh(new Date(NOW.getTime() + MINUTE));
  assert.deepEqual(second, { kind: "unchanged" });
  assert.equal(heldState(file.intake, NOW).snapshot, before.snapshot, "the held snapshot is the one from the first read");
  assert.equal(heldState(file.intake, NOW).readAt, before.readAt, "and it is still read from when it was accepted");
});

test("a snapshot older than the held one is refused, and the refusal repeats once", async () => {
  const file = fakeFile(aged(10));
  await file.intake.refresh(NOW);

  file.set(aged(60));
  const first = await file.intake.refresh(NOW);
  assert.deepEqual(first, { kind: "rejected", reason: "older than the snapshot held", repeat: false });
  const second = await file.intake.refresh(NOW);
  assert.deepEqual(second, { kind: "rejected", reason: "older than the snapshot held", repeat: true }, "logged once");
  assert.equal(heldState(file.intake, NOW).snapshot.generatedAt, new Date(NOW.getTime() - 10 * MINUTE).toISOString(), "the newer held one stays");
});

test("a newer snapshot replaces the held one even when its events are identical", async () => {
  const file = fakeFile(aged(10));
  assert.equal((await file.intake.refresh(NOW)).kind, "accepted", "the first push is the snapshot");

  file.set(aged(5));
  const again = await file.intake.refresh(NOW);
  assert.equal(again.kind, "accepted", "the same events, a newer generatedAt: that is the heartbeat");
  assert.equal(heldState(file.intake, NOW).snapshot.generatedAt, new Date(NOW.getTime() - 5 * MINUTE).toISOString());
});

test("a rejected snapshot leaves the held one alone, and a good one clears the repeat", async () => {
  const file = fakeFile(aged(10));
  await file.intake.refresh(NOW);

  file.set(withEvent({ attendees: -1 }));
  const bad = await file.intake.refresh(NOW);
  assert.deepEqual(bad, {
    kind: "rejected",
    reason: "events[0].attendees: not a non-negative integer",
    repeat: false,
  });
  assert.equal(heldState(file.intake, NOW).snapshot.generatedAt, new Date(NOW.getTime() - 10 * MINUTE).toISOString());

  file.set(aged(5));
  assert.equal((await file.intake.refresh(NOW)).kind, "accepted");
  // The same content failing again after a good push is news again, not a repeat:
  // the caller has logged an acceptance in between.
  file.set(withEvent({ attendees: -1 }));
  assert.equal((await file.intake.refresh(NOW)).kind, "rejected");
  const again = await file.intake.refresh(NOW);
  assert.equal(again.kind, "rejected");
  if (again.kind !== "rejected") return;
  assert.equal(again.repeat, true);
});

test("no file yet is missing, and there is nothing to read", async () => {
  const file = fakeFile(aged(10));
  file.setError(fsError("ENOENT", "ENOENT: no such file or directory, open '/var/lib/zy/calendar.json'"));
  assert.deepEqual(await file.intake.refresh(NOW), { kind: "missing" });
  assert.equal(file.intake.current(NOW), null, "no snapshot, no state");
});

test("a read that fails is a rejection, and the held snapshot stays", async () => {
  const file = fakeFile(aged(10));
  await file.intake.refresh(NOW);

  file.setError(fsError("EACCES", "EACCES: permission denied, open '/var/lib/zy/calendar.json'"));
  const refresh = await file.intake.refresh(NOW);
  assert.equal(refresh.kind, "rejected");
  if (refresh.kind !== "rejected") return;
  assert.match(refresh.reason, /^snapshot file: EACCES: permission denied/);
  assert.equal(refresh.repeat, false);
  assert.equal(heldState(file.intake, NOW).snapshot.events.length, 1, "a read that failed does not empty the state");
});

// ---- Freshness --------------------------------------------------------------

test("freshness is fresh, stale and expired at 10, 60 and 600 minutes old", async () => {
  const cases = [
    [10, "fresh"],
    [60, "stale"],
    [600, "expired"],
  ] as const;
  for (const [minutes, freshness] of cases) {
    const file = fakeFile(aged(minutes));
    assert.equal((await file.intake.refresh(NOW)).kind, "accepted");
    const state = heldState(file.intake, NOW);
    assert.equal(state.freshness, freshness, `${minutes} minutes old`);
    assert.equal(state.snapshot.events.length, 1, "a stale or expired snapshot is still returned, and still used");
    assert.equal(state.snapshot.generatedAt, new Date(NOW.getTime() - minutes * MINUTE).toISOString());
  }
});

test("45 minutes is still fresh, and a minute more is stale", async () => {
  const fresh = fakeFile(aged(45));
  await fresh.intake.refresh(NOW);
  assert.equal(heldState(fresh.intake, NOW).freshness, "fresh");

  const stale = fakeFile(aged(46));
  await stale.intake.refresh(NOW);
  assert.equal(heldState(stale.intake, NOW).freshness, "stale");
});

test("a closed window is expired however recently it was generated", async () => {
  // Generated a minute ago, for a window that ended yesterday: worth nothing now.
  const closed = snapshotFile({
    generatedAt: new Date(NOW.getTime() - MINUTE).toISOString(),
    window: { start: "2026-11-29T16:00:00Z", end: "2026-11-30T16:00:00Z" },
  });
  const file = fakeFile(closed);
  await file.intake.refresh(NOW);
  assert.equal(heldState(file.intake, NOW).freshness, "expired");
});

test("freshness is generatedAt's, never the read's: a restart does not make an old snapshot new", async () => {
  const file = fakeFile(aged(120));
  await file.intake.refresh(NOW);
  const state = heldState(file.intake, NOW);
  assert.equal(state.readAt.getTime(), NOW.getTime(), "read just now");
  assert.equal(state.freshness, "stale", "and two hours old all the same");
});

// ---- The lines --------------------------------------------------------------

test("the calendar mode's lines are a summary and one line per event, ids only", async () => {
  const file = fakeFile(snapshotFile());
  await file.intake.refresh(NOW);
  assert.deepEqual(snapshotLines(heldState(file.intake, NOW), NOW), [
    "snapshot 2026-12-01T02:15:03Z, window 2026-11-30T16:00:00Z..2026-12-02T16:00:00Z, 1 event, 0 all-day, fresh, age 10m",
    "9f2c41d07ab3e6c1 2026-12-01T03:00:00Z 2026-12-01T04:00:00Z false accepted domains=1",
  ]);
});

test("a refresh is worth a line only when it has news", async () => {
  const file = fakeFile(snapshotFile());
  const accepted = await file.intake.refresh(NOW);
  assert.equal(calendarRefreshLine(accepted), "calendar: snapshot 2026-12-01T02:15:03Z: 1 event, 0 all-day");

  assert.equal(
    calendarRefreshLine({ kind: "rejected", reason: "events[0].title: not a string", repeat: false }),
    "calendar: snapshot rejected: events[0].title: not a string",
  );
  assert.equal(calendarRefreshLine({ kind: "rejected", reason: "events[0].title: not a string", repeat: true }), null, "logged once");
  assert.equal(calendarRefreshLine({ kind: "unchanged" }), null, "a duplicate push is a silent no-op");
  assert.equal(calendarRefreshLine({ kind: "missing" }), null, "the run line already says no snapshot yet");

  const state = heldState(file.intake, NOW);
  assert.equal(calendarFreshnessLine(state, NOW), "calendar: fresh, snapshot 2026-12-01T02:15:03Z (age 10m)");
  assert.equal(
    calendarFreshnessLine({ ...state, freshness: "stale" }, new Date(NOW.getTime() + 60 * MINUTE)),
    "calendar: stale, snapshot 2026-12-01T02:15:03Z (age 70m)",
  );
});

// ---- The tick ---------------------------------------------------------------

/** A watcher over one file, with the clock and the log the test controls. */
function watcherOver(
  file: FakeFile,
  clock: () => Date,
  lines: string[],
  record: (report: { at: Date }) => void = () => {},
): ReturnType<typeof calendarWatcher> {
  return calendarWatcher({ intake: file.intake, record, now: clock, log: (line) => lines.push(line) });
}

test("a rejection that repeats is logged once over three ticks", async () => {
  const lines: string[] = [];
  // "{}" is refused at its first field, v: not 1, on every read: the same rejection.
  const file = fakeFile("{}");
  const watcher = watcherOver(file, () => NOW, lines);
  await watcher.tick({ at: NOW });
  await watcher.tick({ at: NOW });
  await watcher.tick({ at: NOW });
  assert.deepEqual(lines, ["calendar: snapshot rejected: v: not 1"], "the second and third say nothing");
  assert.equal(file.intake.current(NOW), null, "and nothing is held");
});

test("a stale snapshot is named once, and an expired one once, however many ticks pass", async () => {
  const lines: string[] = [];
  // Generated at NOW-60m, its window ends at NOW+60m: stale, then expired.
  const file = fakeFile(aged(60));
  let clock = NOW;
  const watcher = watcherOver(file, () => clock, lines);
  await watcher.start();
  await watcher.tick({ at: clock });
  clock = new Date(NOW.getTime() + 120 * MINUTE);
  await watcher.tick({ at: clock });
  await watcher.tick({ at: clock });
  assert.deepEqual(lines, [
    "calendar: stale, snapshot 2026-12-01T01:25:03.000Z (age 60m)",
    "calendar: expired, snapshot 2026-12-01T01:25:03.000Z (age 180m)",
  ]);
});

test("a fresh, then stale, then expired walk logs three freshness lines", async () => {
  const lines: string[] = [];
  // Generated at NOW-10m, its window ends at NOW+110m: fresh, stale, then expired.
  const file = fakeFile(aged(10));
  let clock = NOW;
  const watcher = watcherOver(file, () => clock, lines);

  await watcher.tick({ at: clock });
  clock = new Date(NOW.getTime() + 60 * MINUTE);
  await watcher.tick({ at: clock });
  clock = new Date(NOW.getTime() + 200 * MINUTE);
  await watcher.tick({ at: clock });

  const freshness = lines.filter((line) => line.includes("(age "));
  assert.deepEqual(freshness, [
    "calendar: fresh, snapshot 2026-12-01T02:15:03.000Z (age 10m)",
    "calendar: stale, snapshot 2026-12-01T02:15:03.000Z (age 70m)",
    "calendar: expired, snapshot 2026-12-01T02:15:03.000Z (age 210m)",
  ]);
  // The same file read three times is one accepted snapshot and two no-ops.
  assert.deepEqual(lines.filter((line) => !line.includes("(age ")), ["calendar: snapshot 2026-12-01T02:15:03.000Z: 1 event, 0 all-day"]);
});

test("the tick tells the health endpoint before it reads the snapshot file", async () => {
  const order: string[] = [];
  const intake = new CalendarIntake({
    path: "/var/lib/zy/calendar.json",
    readFile: async () => {
      order.push("read");
      return aged(10);
    },
  });
  const watcher = calendarWatcher({
    intake,
    record: (report) => order.push(`record ${report.at.toISOString()}`),
    now: () => NOW,
    log: () => {},
  });
  await watcher.tick({ at: NOW });
  // A mount that is slow, or gone, must not delay the only signal the liveness
  // probe has.
  assert.deepEqual(order, ["record 2026-12-01T02:25:03.000Z", "read"]);
});

// ---- Privacy ----------------------------------------------------------------

/** Every string a caller could print, but not the payload itself: a title lives in the snapshot, not in a line. */
function reportedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (value instanceof Date) return [value.toISOString()];
  if (Array.isArray(value)) return value.flatMap((item) => reportedStrings(item));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, field]) => (key === "snapshot" ? [] : reportedStrings(field)));
  }
  return [];
}

test("a title and a domain never appear in anything the module reports or a mode prints", async () => {
  const secret = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      generatedAt: "2026-12-01T02:15:03Z",
      window: { start: "2026-11-30T16:00:00Z", end: "2026-12-02T16:00:00Z" },
      events: [event({ title: "ACME-SECRET", domains: ["acme-secret.example"], ...over })],
    });
  const SECRETS = ["ACME-SECRET", "acme-secret.example"];

  const good = secret();
  const snapshot = parseSnapshot(good, NOW);
  assert.equal(snapshot.events[0].title, "ACME-SECRET", "the fixture really carries the secret");

  const file = fakeFile(good);
  const accepted = await file.intake.refresh(NOW);
  const state = heldState(file.intake, NOW);

  // A rejection of the same content, a read that failed, and the lines a mode builds.
  file.set(secret({ attendees: -1 }));
  const rejected = await file.intake.refresh(NOW);
  file.setError(fsError("EACCES", "EACCES: permission denied, open '/var/lib/zy/calendar.json'"));
  const unreadable = await file.intake.refresh(NOW);

  const strings = [
    ...reportedStrings(accepted),
    ...reportedStrings(rejected),
    ...reportedStrings(unreadable),
    ...reportedStrings(state),
    ...snapshotLines(state, NOW),
    calendarFreshnessLine(state, NOW),
  ];
  assert.ok(strings.length > 10, "there is something to check");
  for (const line of strings) {
    for (const value of SECRETS) assert.ok(!line.includes(value), `a line repeats ${value}: ${line}`);
  }
});
