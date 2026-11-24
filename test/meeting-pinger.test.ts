// The sending side of the meeting pings: the snapshot read from a fake file, the
// asks stored in an in-memory SQLite store, the DM a fake. No Slack, no Mac, no
// timers, and every log line captured.
//
// Wall-clock times are Singapore's, the suite's default ASSISTANT_TZ, and the days
// are real ones (Tue 1 Dec 2026 is a Tuesday). Synthetic names only: the event ids
// the Mac would derive, and titles that must never reach a line.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CalendarIntake, type CalendarEvent } from "../src/calendar.ts";
import { createMeetingPinger, type MeetingPinger } from "../src/meeting-pinger.ts";
import type { Sent, Sender } from "../src/slack.ts";
import {
  openStore,
  type MeetingPingRecord,
  type MeetingPingStore,
  type NewMeetingPing,
  type SqliteStore,
} from "../src/store.ts";

const MINUTE = 60_000;

/** A Singapore wall-clock instant. */
const sg = (text: string): Date => new Date(`${text}+08:00`);

/** The same instant as the ISO text the snapshot holds. */
const at = (text: string): string => sg(text).toISOString();

/** Tue 1 Dec 2026, 10:00 local: the clock every test reads at. */
const NOW = sg("2026-12-01T10:00");

/** An event id the Mac would derive, 16 hex characters. */
const id = (n: number): string => n.toString(16).padStart(16, "0");

/** One event as the snapshot holds it, with whatever the test changes. */
function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: id(1),
    start: at("2026-12-01T09:00"),
    end: at("2026-12-01T09:30"),
    allDay: false,
    title: "Acme weekly sync",
    domains: ["demo.example"],
    attendees: 6,
    status: "accepted",
    ...over,
  };
}

/** A meeting that ended `minutes` before NOW, after running half an hour. */
function ended(minutes: number, over: Partial<CalendarEvent> = {}): CalendarEvent {
  const end = NOW.getTime() - minutes * MINUTE;
  return event({ start: new Date(end - 30 * MINUTE).toISOString(), end: new Date(end).toISOString(), ...over });
}

/** The file the Mac would have written: a window around today, generated this morning. */
function snapshotText(events: CalendarEvent[]): string {
  return JSON.stringify({
    v: 1,
    generatedAt: at("2026-12-01T07:30"),
    window: { start: at("2026-12-01T00:00"), end: at("2026-12-02T00:00") },
    events,
  });
}

/** The DM side, and the one send a test can make fail. */
class FakeDm implements Pick<Sender, "sendDm"> {
  readonly dms: string[] = [];
  attempts = 0;
  /** The nth send fails, and only that one: the retry succeeds. */
  failOnAttempt: number | null = null;

  async sendDm(text: string): Promise<Sent> {
    this.attempts += 1;
    if (this.failOnAttempt !== null && this.attempts === this.failOnAttempt) {
      this.failOnAttempt = null;
      throw new Error("slack is down");
    }
    this.dms.push(text);
    return { channel: "DM", ts: `dm-${this.dms.length}` };
  }
}

/**
 * A DM that hangs until the test lets it go: one send that outlasts a tick, which
 * is what two runs overlapping look like with no timers. `started` resolves once a
 * send is waiting, so the second run is started at exactly that moment.
 */
class HeldDm implements Pick<Sender, "sendDm"> {
  readonly dms: string[] = [];
  #release = (): void => {};
  #started = (): void => {};
  readonly started = new Promise<void>((resolve) => {
    this.#started = resolve;
  });
  readonly held = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  release(): void {
    this.#release();
  }

  async sendDm(text: string): Promise<Sent> {
    this.#started();
    await this.held;
    this.dms.push(text);
    return { channel: "DM", ts: `dm-${this.dms.length}` };
  }
}

/** A store that cannot be read: what a whole run's one line is for. */
class BrokenStore implements MeetingPingStore {
  recordMeetingPing(_p: NewMeetingPing): void {}

  meetingPingKeys(_date: string): Set<string> {
    throw new Error("the disk is gone");
  }

  findMeetingPingByMessage(_channel: string, _ts: string): MeetingPingRecord | null {
    return null;
  }
}

interface Harness {
  pinger: MeetingPinger;
  store: SqliteStore;
  /** The sender the pinger was given: the fake, or the test's own. */
  dm: Pick<Sender, "sendDm"> & { readonly dms: string[] };
  lines: string[];
  intake: CalendarIntake;
}

/**
 * The pinger as `run` builds it: one intake over the file, the real store in
 * memory, a fake DM, and the lines it logs collected. `accept: false` is a pod
 * that has not read a snapshot yet. `dm` is a sender of the test's own, for a
 * send that has to hang: the tick after it starts is then a fake, not a timer.
 */
async function harness(
  events: CalendarEvent[],
  options: { accept?: boolean; failOnAttempt?: number; dm?: Pick<Sender, "sendDm"> & { readonly dms: string[] } } = {},
): Promise<Harness> {
  const intake = new CalendarIntake({ path: "/var/lib/zy/calendar.json", readFile: async () => snapshotText(events) });
  if (options.accept ?? true) await intake.refresh(NOW);
  const store = openStore(":memory:");
  const dm = new FakeDm();
  if (options.failOnAttempt !== undefined) dm.failOnAttempt = options.failOnAttempt;
  const lines: string[] = [];
  const pinger = createMeetingPinger({
    intake,
    store,
    sender: options.dm ?? dm,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  return { pinger, store, dm: options.dm ?? dm, lines, intake };
}

test("one DM per due meeting, recorded as each goes out", async () => {
  const h = await harness([
    ended(30, { id: id(1), title: "Acme weekly sync" }),
    ended(10, { id: id(2), title: "Demo renewal" }),
    // Too long ago to be news, and not a meeting at all: neither is asked about.
    ended(120, { id: id(3) }),
    event({ id: id(4), allDay: true, start: at("2026-12-01T00:00"), end: at("2026-12-02T00:00") }),
  ]);
  await h.pinger.run(NOW);

  assert.equal(h.dm.dms.length, 2, "the two meetings that ended recently, one DM each");
  assert.deepEqual(h.lines, [`meeting ping ${id(1)}: sent`, `meeting ping ${id(2)}: sent`], "earliest end first");
  assert.deepEqual(h.store.meetingPingKeys("2026-12-01"), new Set([`meeting:${id(1)}`, `meeting:${id(2)}`]));

  const rows = h.store.meetingPingKeys("2026-12-01");
  assert.equal(rows.size, 2);
  assert.deepEqual(h.store.findMeetingPingByMessage("DM", "dm-1"), {
    key: `meeting:${id(1)}`,
    eventId: id(1),
    date: "2026-12-01",
    title: "Acme weekly sync",
    sentAt: NOW.toISOString(),
    channel: "DM",
    ts: "dm-1",
  });
  assert.equal(h.store.findMeetingPingByMessage("DM", "dm-2")?.eventId, id(2), "the thread a reply lands in is the ask");
  assert.equal(h.store.findMeetingPingByMessage("DM", "dm-9"), null);
  h.store.close();
});

test("a second run in the same minute sends nothing: the store holds the keys", async () => {
  const h = await harness([ended(30, { id: id(1) }), ended(10, { id: id(2) })]);
  await h.pinger.run(NOW);
  assert.equal(h.dm.dms.length, 2);

  await h.pinger.run(NOW);
  assert.equal(h.dm.dms.length, 2, "nothing is asked twice");
  assert.equal(h.lines.length, 2, "and nothing is logged twice");
  h.store.close();
});

test("two runs overlapping ask once: the second returns at once and says why", async () => {
  const held = new HeldDm();
  const h = await harness([ended(30, { id: id(1) })], { dm: held });

  const first = h.pinger.run(NOW);
  await held.started; // the first run is in the middle of its one send

  // The tick after, while that send is still out: the store has no key for it yet,
  // so without the guard this second run would ask the same meeting again.
  const second = h.pinger.run(NOW);
  held.release();
  await Promise.all([first, second]);

  assert.equal(held.dms.length, 1, "one DM between the two runs");
  assert.deepEqual(
    h.lines,
    ["meeting pings skipped: the previous run is still running", `meeting ping ${id(1)}: sent`],
    "the line says why, once, and the first run finished normally",
  );
  assert.deepEqual(h.store.meetingPingKeys("2026-12-01"), new Set([`meeting:${id(1)}`]), "and one row");

  // The guard is not sticky: a run after the first has finished is a run, and finds
  // the key and nothing to ask.
  await h.pinger.run(NOW);
  assert.equal(held.dms.length, 1);
  assert.equal(h.lines.length, 2, "and says nothing more");
  h.store.close();
});

test("a failed send logs one line, does not throw, and the next run retries only what is unsent", async () => {
  const h = await harness([ended(30, { id: id(1) }), ended(10, { id: id(2) })], { failOnAttempt: 2 });
  await h.pinger.run(NOW); // never rejects: awaiting it is the assertion

  assert.equal(h.dm.dms.length, 1, "the first went out, the second did not");
  assert.deepEqual(h.lines, [`meeting ping ${id(1)}: sent`, `meeting ping ${id(2)}: failed: slack is down`]);
  assert.deepEqual(h.store.meetingPingKeys("2026-12-01"), new Set([`meeting:${id(1)}`]), "only what arrived is recorded");

  await h.pinger.run(NOW);
  assert.equal(h.dm.dms.length, 2, "the ask that failed went out on the next tick");
  assert.deepEqual(h.store.meetingPingKeys("2026-12-01"), new Set([`meeting:${id(1)}`, `meeting:${id(2)}`]));
  assert.deepEqual(h.lines.slice(2), [`meeting ping ${id(2)}: sent`], "and the one already sent was not asked again");
  h.store.close();
});

test("the cap counts the store's own keys: a seventh ask is not made", async () => {
  // The earliest end first: id 1 ended twelve minutes ago, id 7 six minutes ago.
  const events = Array.from({ length: 7 }, (_, i) => ended(12 - i, { id: id(i + 1) }));
  const h = await harness(events);
  await h.pinger.run(NOW);

  assert.equal(h.dm.dms.length, 6, "the day's six, earliest end first");
  assert.deepEqual(h.lines, Array.from({ length: 6 }, (_, i) => `meeting ping ${id(i + 1)}: sent`));

  await h.pinger.run(NOW);
  assert.equal(h.dm.dms.length, 6, "the seventh waits for a day it never gets: the cap is the whole run's");
  h.store.close();
});

test("no snapshot sends nothing and logs nothing", async () => {
  const h = await harness([ended(30)], { accept: false });
  await h.pinger.run(NOW);
  assert.equal(h.dm.dms.length, 0);
  assert.deepEqual(h.lines, []);
  h.store.close();
});

test("a run that cannot read its keys is one line, not a throw", async () => {
  const lines: string[] = [];
  const dm = new FakeDm();
  const intake = new CalendarIntake({ path: "/var/lib/zy/calendar.json", readFile: async () => snapshotText([ended(30)]) });
  await intake.refresh(NOW);
  const pinger = createMeetingPinger({
    intake,
    store: new BrokenStore(),
    sender: dm,
    now: () => NOW,
    log: (line) => lines.push(line),
  });
  await pinger.run(NOW);
  assert.deepEqual(lines, ["meeting pings: the disk is gone"]);
  assert.equal(dm.dms.length, 0);
});

test("no title reaches a log line, on the way out or on a failure", async () => {
  const h = await harness(
    [ended(30, { id: id(1), title: "Secret Customer Renewal" }), ended(10, { id: id(2), title: "Secret Board Prep" })],
    { failOnAttempt: 2 },
  );
  await h.pinger.run(NOW);
  assert.equal(h.lines.length, 2);
  for (const line of h.lines) {
    assert.ok(!line.includes("Secret"), line);
    assert.ok(!line.includes("Renewal") && !line.includes("Board Prep"), line);
  }
  h.store.close();
});

test("the same key twice is one row, and the first send keeps the thread", async () => {
  const store = openStore(":memory:");
  const first: NewMeetingPing = {
    key: "meeting:9f2c41d07ab3e6c1",
    eventId: "9f2c41d07ab3e6c1",
    date: "2026-12-01",
    title: "Acme weekly sync",
    sentAt: "2026-12-01T02:00:00.000Z",
    channel: "DM",
    ts: "dm-1",
  };
  store.recordMeetingPing(first);
  // First wins: the row is the thread a reply may already hang under, so a second
  // send for the same key must leave it, not move it.
  store.recordMeetingPing({ ...first, ts: "dm-2", sentAt: "2026-12-01T02:01:00.000Z" });
  assert.equal(store.meetingPingKeys("2026-12-01").size, 1);
  assert.equal(store.findMeetingPingByMessage("DM", "dm-2"), null, "the second send is not the anchor");
  assert.deepEqual(store.findMeetingPingByMessage("DM", "dm-1"), first, "the first one is, unchanged");
  store.close();
});
