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
  foreignZone,
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

/** The file a version 2 Mac writes: a version 1 file and the zone its window was built in. */
function zonedFile(tz: unknown, over: Record<string, unknown> = {}): string {
  return snapshotFile({ v: 2, tz, ...over });
}

/** The reason a snapshot file is refused: the message the caller would log. */
function refused(text: string): string {
  try {
    parseSnapshot(text, NOW);
  } catch (err) {
    assert.ok(err instanceof Error, "a refusal is an Error");
    return err.message;
  }
  assert.fail("the snapshot parsed, so there is no refusal to read");
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

test("a snapshot that is not version 1 or 2 is refused", () => {
  // A version 3 file may mean anything, so it is refused rather than read as the
  // nearest version this parser knows.
  assert.throws(() => parseSnapshot(snapshotFile({ v: 3 }), NOW), /^Error: v: not 1 or 2$/);
  assert.throws(() => parseSnapshot(snapshotFile({ v: "1" }), NOW), /^Error: v: not 1 or 2$/);
  assert.throws(() => parseSnapshot(snapshotFile({ v: undefined }), NOW), /^Error: v: not 1 or 2$/);
  assert.throws(() => parseSnapshot(snapshotFile({ v: 0 }), NOW), /^Error: v: not 1 or 2$/);
});

test("a version 2 file parses, and keeps the zone it declares", () => {
  const snapshot = parseSnapshot(zonedFile("Asia/Singapore"), NOW);
  assert.equal(snapshot.tz, "Asia/Singapore");
  // The zone is the whole difference: every other field parses as version 1 parses it.
  assert.deepEqual(snapshot, { ...parseSnapshot(snapshotFile(), NOW), tz: "Asia/Singapore" });
});

test("a version 1 file holds no zone at all, and a tz key in one is ignored", () => {
  const plain = parseSnapshot(snapshotFile(), NOW);
  // Absent, not defaulted: a version 1 file declared nothing, so there is nothing for
  // a caller to compare, and a whole-snapshot compare still sees the same fields.
  assert.ok(!("tz" in plain), "a version 1 parse carries no tz key");
  const withKey = parseSnapshot(snapshotFile({ tz: "Europe/London" }), NOW);
  assert.ok(!("tz" in withKey), "the version says what a file means, so a tz key in version 1 is an unknown key");
  assert.deepEqual(withKey, plain);
});

test("tz has to be a zone name, and no refusal repeats one", () => {
  const cases: Array<[unknown, string]> = [
    [7, "tz: not a string"],
    // Exact, so it proves the empty value the reason is about is not echoed: there is
    // nothing of it to echo.
    ["", "tz: empty"],
    ["Mars/Base", "tz: unknown time zone"],
    // The shape is checked before Intl, so a newline never reaches a log line.
    ["Asia/Singapore\n", "tz: not a zone name"],
    ["a".repeat(65), "tz: not a zone name"],
  ];
  for (const [value, reason] of cases) {
    const message = refused(zonedFile(value));
    assert.equal(message, reason, JSON.stringify(value));
    assert.ok(!message.includes("\n"), `a refusal is one line: ${JSON.stringify(message)}`);
    if (typeof value === "string" && value !== "") {
      assert.ok(!message.includes(value), `the message repeats the zone: ${JSON.stringify(message)}`);
    }
  }
  // 64 characters passes the shape check and reaches Intl, which is what knows a zone
  // name from a string of letters.
  assert.equal(refused(zonedFile("a".repeat(64))), "tz: unknown time zone");
  // A zone with a space around it is a bad name, not one quietly repaired: nothing is
  // trimmed, so a trailing newline is a bad character rather than whitespace.
  assert.equal(refused(zonedFile(" Asia/Singapore")), "tz: not a zone name");
});

test("foreignZone names a declared zone only when it is not this bot's", () => {
  assert.equal(foreignZone(parseSnapshot(snapshotFile(), NOW)), null, "a version 1 file declared no zone");
  assert.equal(foreignZone(parseSnapshot(zonedFile("Asia/Singapore"), NOW)), null, "the bot's own zone agrees with itself");
  assert.equal(foreignZone(parseSnapshot(zonedFile("Europe/London"), NOW)), "Europe/London");
  // The same offset as Singapore all year, and still a mismatch: what the two sides
  // disagree about is where the day starts and ends, not what the clock reads now.
  assert.equal(foreignZone(parseSnapshot(zonedFile("Asia/Kuala_Lumpur"), NOW)), "Asia/Kuala_Lumpur");
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

/**
 * A Singapore wall-clock instant. Freshness is today's local date's business, and
 * the suite pins TZ at its default: 07:30 here is 23:30Z the evening before.
 */
const sg = (text: string): Date => new Date(`${text}+08:00`);

const DAY = 86_400_000;

/** Tue 1 Dec 2026, local midnight: the day the freshness tests are read on. */
const TUE = Date.parse("2026-12-01T00:00:00+08:00");

/** A push at a local wall-clock time, over a window of two days from `midnight`. */
function push(at: Date, midnight: number = TUE): string {
  return snapshotFile({
    generatedAt: at.toISOString(),
    window: { start: new Date(midnight).toISOString(), end: new Date(midnight + 2 * DAY).toISOString() },
  });
}

test("a push from this morning is still fresh a minute before midnight", async () => {
  // The Mac pushes at 07:30 and 18:30: an age in minutes would call this stale by
  // lunchtime, for a snapshot that is still the one about today.
  const file = fakeFile(push(sg("2026-12-01T07:30")));
  assert.equal((await file.intake.refresh(sg("2026-12-01T07:31"))).kind, "accepted");
  const state = heldState(file.intake, sg("2026-12-01T23:59"));
  assert.equal(state.freshness, "fresh");
  assert.equal(state.snapshot.events.length, 1, "and it is still the snapshot in use");
});

test("yesterday evening's push is stale a minute after midnight, and still returned", async () => {
  const file = fakeFile(push(sg("2026-11-30T18:30"), TUE - DAY));
  assert.equal((await file.intake.refresh(sg("2026-11-30T18:31"))).kind, "accepted");
  const state = heldState(file.intake, sg("2026-12-01T00:01"));
  assert.equal(state.freshness, "stale", "today's push has not arrived");
  assert.equal(state.snapshot.events.length, 1, "a stale snapshot is still used");
});

test("a push three minutes ahead of the clock still reads fresh across midnight", async () => {
  // A Mac's clock may be up to five minutes ahead, so around midnight it names
  // tomorrow's date: that is still this moment's snapshot, not a stale one.
  const file = fakeFile(push(sg("2026-12-02T00:03")));
  assert.equal((await file.intake.refresh(sg("2026-12-01T23:59"))).kind, "accepted");
  assert.equal(heldState(file.intake, sg("2026-12-01T23:59")).freshness, "fresh");
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

test("a window pushed today is expired too once its end is past", async () => {
  // Pushed at 00:10 for a window that ends at midnight: yesterday's meetings, and
  // expiry is asked before freshness so the push's own date cannot save them.
  const file = fakeFile(
    snapshotFile({
      generatedAt: sg("2026-12-01T00:10").toISOString(),
      window: { start: sg("2026-11-30T00:00").toISOString(), end: sg("2026-12-01T00:00").toISOString() },
    }),
  );
  await file.intake.refresh(sg("2026-12-01T00:10"));
  assert.equal(heldState(file.intake, sg("2026-12-01T10:25")).freshness, "expired");
});

test("freshness is generatedAt's, never the read's: a restart does not make an old snapshot new", async () => {
  const file = fakeFile(push(sg("2026-11-30T18:30"), TUE - DAY));
  await file.intake.refresh(sg("2026-12-01T09:00"));
  const state = heldState(file.intake, sg("2026-12-01T09:00"));
  assert.equal(state.readAt.getTime(), sg("2026-12-01T09:00").getTime(), "read just now");
  assert.equal(state.freshness, "stale", "and pushed last evening all the same");
});

test("a snapshot from another zone, pushed today, still reads fresh", async () => {
  // Its days are not this bot's, and that is a disagreement to state, not an age: a
  // foreign snapshot was pushed and it parsed, so it is neither stale nor expired.
  const file = fakeFile(
    zonedFile("Europe/London", {
      generatedAt: sg("2026-12-01T07:30").toISOString(),
      window: { start: new Date(TUE).toISOString(), end: new Date(TUE + 2 * DAY).toISOString() },
    }),
  );
  assert.equal((await file.intake.refresh(sg("2026-12-01T07:31"))).kind, "accepted");
  const state = heldState(file.intake, sg("2026-12-01T07:31"));
  assert.equal(state.freshness, "fresh");
  assert.equal(foreignZone(state.snapshot), "Europe/London", "and the zone is still the one it declared");
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

/** The three line builders' output for one file, read at one instant. */
async function linesFor(text: string, at: Date): Promise<{ refresh: string | null; summary: string; freshness: string }> {
  const file = fakeFile(text);
  const refresh = await file.intake.refresh(at);
  const state = heldState(file.intake, at);
  return {
    refresh: calendarRefreshLine(refresh),
    summary: snapshotLines(state, at)[0],
    freshness: calendarFreshnessLine(state, at),
  };
}

/** Seven events, so the counts on the line are not the single-event fixture's. */
const SEVEN = { events: manyEvents(7) };

test("the lines say nothing about a zone a version 1 file did not declare", async () => {
  assert.deepEqual(
    await linesFor(snapshotFile(SEVEN), NOW),
    {
      refresh: "calendar: snapshot 2026-12-01T02:15:03Z: 7 events, 0 all-day",
      summary:
        "snapshot 2026-12-01T02:15:03Z, window 2026-11-30T16:00:00Z..2026-12-02T16:00:00Z, 7 events, 0 all-day, fresh, age 10m",
      freshness: "calendar: fresh, snapshot 2026-12-01T02:15:03Z (age 10m)",
    },
    "a version 1 file's lines are 0.12.0's, character for character",
  );
});

test("the lines name the zone a matching version 2 file declares", async () => {
  assert.deepEqual(await linesFor(zonedFile("Asia/Singapore", SEVEN), NOW), {
    refresh: "calendar: snapshot 2026-12-01T02:15:03Z: 7 events, 0 all-day, tz Asia/Singapore",
    summary:
      "snapshot 2026-12-01T02:15:03Z, window 2026-11-30T16:00:00Z..2026-12-02T16:00:00Z, 7 events, 0 all-day, fresh, age 10m, tz Asia/Singapore",
    freshness: "calendar: fresh, snapshot 2026-12-01T02:15:03Z (age 10m)",
  });
});

test("the lines state a foreign zone, and say its meetings and asks are off", async () => {
  // Zone identifiers, counts and instants: the snapshot's twice-pushed and titled
  // events stay out of every line, however far wrong its zone is.
  assert.deepEqual(await linesFor(zonedFile("Europe/London", SEVEN), NOW), {
    refresh:
      "calendar: snapshot 2026-12-01T02:15:03Z: 7 events, 0 all-day, tz Europe/London, not Asia/Singapore: its meetings and asks are off",
    summary:
      "snapshot 2026-12-01T02:15:03Z, window 2026-11-30T16:00:00Z..2026-12-02T16:00:00Z, 7 events, 0 all-day, fresh, age 10m, tz Europe/London, not Asia/Singapore: its meetings and asks are off",
    freshness: "calendar: fresh, snapshot 2026-12-01T02:15:03Z (age 10m)",
  });
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

/** The file a version 2 Mac writes at a local wall-clock time, over today and tomorrow. */
const zonedPush = (tz: string, at: Date): string =>
  zonedFile(tz, {
    generatedAt: at.toISOString(),
    window: { start: new Date(TUE).toISOString(), end: new Date(TUE + 2 * DAY).toISOString() },
  });

/** The watcher's zone lines: the mismatch, the way back, and the version 1 file on the way out. */
const zoneLines = (lines: string[]): string[] =>
  lines.filter((line) => line.includes("snapshot in ") || line.includes("snapshot has no zone "));

test("the startup read states the opening zone, and the watcher says a later change", async () => {
  const lines: string[] = [];
  const clock = sg("2026-12-01T07:35");
  const file = fakeFile(zonedPush("Europe/London", sg("2026-12-01T07:30")));
  const watcher = watcherOver(file, () => clock, lines);

  // The run line names this zone, so the opening read and a second push in the same
  // foreign zone say nothing: one disagreement, one line.
  await watcher.start();
  file.set(zonedPush("Europe/London", sg("2026-12-01T07:31")));
  await watcher.tick({ at: clock });
  assert.deepEqual(zoneLines(lines), [], "the opening zone and a repeat of it say nothing");

  file.set(zonedPush("Asia/Singapore", sg("2026-12-01T07:32")));
  await watcher.tick({ at: clock });
  file.set(zonedPush("Europe/London", sg("2026-12-01T07:33")));
  await watcher.tick({ at: clock });

  assert.deepEqual(zoneLines(lines), [
    "calendar: snapshot in Asia/Singapore again",
    "calendar: snapshot in Europe/London, not Asia/Singapore: its meetings and asks are off",
  ]);
});

test("leaving a foreign zone for a version 1 file says the zone is assumed again", async () => {
  const lines: string[] = [];
  const clock = sg("2026-12-01T07:35");
  const file = fakeFile(zonedPush("Europe/London", sg("2026-12-01T07:30")));
  const watcher = watcherOver(file, () => clock, lines);
  await watcher.start();

  file.set(push(sg("2026-12-01T07:31")));
  await watcher.tick({ at: clock });
  // A second version 1 push declares nothing either: the assumption has not changed.
  file.set(push(sg("2026-12-01T07:32")));
  await watcher.tick({ at: clock });

  assert.deepEqual(zoneLines(lines), ["calendar: snapshot has no zone again, assuming Asia/Singapore"]);
});

test("a foreign zone is said once, and coming back is said once", async () => {
  const lines: string[] = [];
  const clock = sg("2026-12-01T07:35");
  const file = fakeFile(zonedPush("Europe/London", sg("2026-12-01T07:30")));
  const watcher = watcherOver(file, () => clock, lines);

  await watcher.tick({ at: clock });
  await watcher.tick({ at: clock });
  // A new push that disagrees in the same way is the same disagreement: no line.
  file.set(zonedPush("Europe/London", sg("2026-12-01T07:31")));
  await watcher.tick({ at: clock });
  file.set(zonedPush("Asia/Singapore", sg("2026-12-01T07:32")));
  await watcher.tick({ at: clock });
  await watcher.tick({ at: clock });
  file.set(zonedPush("Europe/London", sg("2026-12-01T07:33")));
  await watcher.tick({ at: clock });

  assert.deepEqual(
    lines.filter((line) => line.includes("snapshot in ")),
    [
      "calendar: snapshot in Europe/London, not Asia/Singapore: its meetings and asks are off",
      "calendar: snapshot in Asia/Singapore again",
      "calendar: snapshot in Europe/London, not Asia/Singapore: its meetings and asks are off",
    ],
    "one line per change of zone, on a file read six times",
  );
});

test("a version 1 file and a matched version 2 one say nothing about a zone", async () => {
  const lines: string[] = [];
  const clock = sg("2026-12-01T07:35");
  for (const text of [push(sg("2026-12-01T07:30")), zonedPush("Asia/Singapore", sg("2026-12-01T07:30"))]) {
    const watcher = watcherOver(fakeFile(text), () => clock, lines);
    await watcher.tick({ at: clock });
    await watcher.tick({ at: clock });
  }

  assert.deepEqual(lines.filter((line) => line.includes("snapshot in ")), [], "no disagreement, no line");
  assert.ok(lines.length > 0, "and the tick still says what it always said");
});

test("a rejection that repeats is logged once over three ticks", async () => {
  const lines: string[] = [];
  // "{}" is refused at its first field, v: not 1 or 2, on every read: the same rejection.
  const file = fakeFile("{}");
  const watcher = watcherOver(file, () => NOW, lines);
  await watcher.tick({ at: NOW });
  await watcher.tick({ at: NOW });
  await watcher.tick({ at: NOW });
  assert.deepEqual(lines, ["calendar: snapshot rejected: v: not 1 or 2"], "the second and third say nothing");
  assert.equal(file.intake.current(NOW), null, "and nothing is held");
});

test("a morning push is logged fresh once and stale once as midnight passes, then expired", async () => {
  const lines: string[] = [];
  // Pushed at 07:30 for a window that ends two days later: fresh, stale, expired.
  const file = fakeFile(push(sg("2026-12-01T07:30")));
  let clock = sg("2026-12-01T23:59");
  const watcher = watcherOver(file, () => clock, lines);

  await watcher.tick({ at: clock });
  await watcher.tick({ at: clock });
  clock = sg("2026-12-02T00:01");
  await watcher.tick({ at: clock });
  await watcher.tick({ at: clock });
  clock = sg("2026-12-03T00:01");
  await watcher.tick({ at: clock });

  assert.deepEqual(lines, [
    "calendar: snapshot 2026-11-30T23:30:00.000Z: 1 event, 0 all-day",
    "calendar: fresh, snapshot 2026-11-30T23:30:00.000Z (age 989m)",
    "calendar: stale, snapshot 2026-11-30T23:30:00.000Z (age 991m)",
    "calendar: expired, snapshot 2026-11-30T23:30:00.000Z (age 2431m)",
  ]);
  // The same file read six times is one accepted snapshot: the ticks after the
  // first are no-ops, and a transition is named once, never per tick.
  assert.deepEqual(lines.filter((line) => !line.includes("(age ")), ["calendar: snapshot 2026-11-30T23:30:00.000Z: 1 event, 0 all-day"]);
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
