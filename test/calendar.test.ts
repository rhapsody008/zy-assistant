// The calendar snapshot without a Mac or a disk: the parser, with the clock passed
// in. Synthetic names only: "demo.example", and the event ids the Mac would derive.
//
// Every rejection is checked for two things at once: the field path it names, and
// that the message repeats nothing the payload says. A title never leaves this
// module, and a domain names a customer.

import assert from "node:assert/strict";
import { test } from "node:test";
import { foreignZone, parseSnapshot, SNAPSHOT_MAX_BYTES } from "../src/calendar.ts";

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
